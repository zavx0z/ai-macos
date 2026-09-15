#include "meta_cursor_display.h"

#import <CoreGraphics/CoreGraphics.h>

#include <math.h>
#include <string.h>

#define META_CURSOR_DISPLAY_MAX_DISPLAYS 64

typedef enum {
  MetaCursorTopologyCurrent,
  MetaCursorTopologyStale,
  MetaCursorTopologyUnavailable,
} MetaCursorTopologyState;

static BOOL cursor_identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) {
    return NO;
  }
  NSString *text = value;
  unichar first = [text characterAtIndex:0];
  BOOL validFirst =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return validFirst &&
         [text rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static BOOL valid_generation(NSDictionary *generation) {
  if (![generation isKindOfClass:NSDictionary.class]) return NO;
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (!cursor_identifier(generation[key], 64)) return NO;
  }
  return YES;
}

static BOOL valid_rect(MetaRect rect) {
  return isfinite(rect.x) && isfinite(rect.y) && isfinite(rect.width) &&
         isfinite(rect.height) && rect.width > 0 && rect.height > 0 &&
         isfinite(rect.x + rect.width) && isfinite(rect.y + rect.height);
}

static BOOL same_rect(MetaRect left, MetaRect right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

static BOOL same_display(const MetaDisplayRecord *left,
                         const MetaDisplayRecord *right) {
  return strcmp(left->display_ref, right->display_ref) == 0 &&
         left->display_id == right->display_id &&
         same_rect(left->bounds, right->bounds) &&
         same_rect(left->usable_bounds, right->usable_bounds) &&
         left->scale == right->scale &&
         left->rotation_degrees == right->rotation_degrees &&
         left->main == right->main;
}

static BOOL valid_displays(const MetaInventorySnapshot *snapshot) {
  if (snapshot->display_count == 0 ||
      snapshot->display_count > META_CURSOR_DISPLAY_MAX_DISPLAYS ||
      snapshot->displays == NULL) {
    return NO;
  }
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    const MetaDisplayRecord *display = &snapshot->displays[index];
    if (!cursor_identifier(@(display->display_ref), 127) ||
        display->display_id == 0 || !valid_rect(display->bounds) ||
        !valid_rect(display->usable_bounds) || !isfinite(display->scale) ||
        display->scale <= 0 || !isfinite(display->rotation_degrees) ||
        display->rotation_degrees < 0 || display->rotation_degrees >= 360) {
      return NO;
    }
    for (size_t other = index + 1; other < snapshot->display_count;
         other += 1) {
      if (display->display_id == snapshot->displays[other].display_id ||
          strcmp(display->display_ref,
                 snapshot->displays[other].display_ref) == 0) {
        return NO;
      }
    }
  }
  return YES;
}

static BOOL snapshot_matches_request(const MetaInventorySnapshot *snapshot,
                                     NSDictionary *generation,
                                     NSString *inventoryId,
                                     uint64_t inventoryRevision,
                                     uint64_t displayLayoutRevision) {
  return snapshot != NULL &&
         [@(snapshot->inventory_id) isEqual:inventoryId] &&
         snapshot->revision == inventoryRevision &&
         snapshot->display_layout_revision == displayLayoutRevision &&
         [@(snapshot->native_generation)
             isEqual:generation[@"nativeGeneration"]];
}

static NSDictionary *cursor_failure(NSString *sourceResponseRef,
                                    NSString *status,
                                    NSString *reason) {
  return @{
    @"status" : status,
    @"sourceResponseRef" : sourceResponseRef,
    @"reason" : reason,
  };
}

static MetaCursorTopologyState probe_topology(
    MetaCursorDisplayBackend backend,
    const MetaInventorySnapshot *snapshot,
    MetaTopologyProbe *output) {
  uint64_t epoch = 0;
  if (!backend.current_topology_epoch(backend.context, &epoch)) {
    return MetaCursorTopologyUnavailable;
  }
  if (snapshot->display_topology_epoch == 0 ||
      epoch != snapshot->display_topology_epoch) {
    return MetaCursorTopologyStale;
  }
  *output = (MetaTopologyProbe){0};
  if (!backend.probe_topology(backend.context, snapshot, output)) {
    uint64_t afterFailure = 0;
    return backend.current_topology_epoch(backend.context, &afterFailure) &&
                   afterFailure != snapshot->display_topology_epoch
               ? MetaCursorTopologyStale
               : MetaCursorTopologyUnavailable;
  }
  if (!output->topology_unchanged) return MetaCursorTopologyStale;
  uint64_t afterEpoch = 0;
  if (!backend.current_topology_epoch(backend.context, &afterEpoch)) {
    return MetaCursorTopologyUnavailable;
  }
  if (afterEpoch != snapshot->display_topology_epoch) {
    return MetaCursorTopologyStale;
  }
  return output->observed_at_unix_micros == 0
             ? MetaCursorTopologyUnavailable
             : MetaCursorTopologyCurrent;
}

static BOOL contains_point(MetaRect bounds, double x, double y) {
  return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width &&
         y < bounds.y + bounds.height;
}

static NSString *iso_from_micros(uint64_t micros) {
  NSDate *date = [NSDate dateWithTimeIntervalSince1970:(double)micros / 1000000.0];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:date];
}

NSDictionary *meta_cursor_display_read_with_backend(
    NSDictionary *trustedGeneration,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t displayLayoutRevision,
    MetaCursorDisplayBackend backend) {
  if (!valid_generation(trustedGeneration) ||
      !cursor_identifier(inventoryId, 127) || backend.snapshot == NULL ||
      backend.probe_topology == NULL ||
      backend.current_topology_epoch == NULL || backend.read_cursor == NULL ||
      inventoryRevision > 9007199254740991ULL ||
      displayLayoutRevision > 9007199254740991ULL) {
    return nil;
  }
  NSString *sourceResponseRef = [@"cursor-display-response-"
      stringByAppendingString:NSUUID.UUID.UUIDString];
  const MetaInventorySnapshot *snapshot = backend.snapshot(backend.context);
  if (snapshot == NULL || !snapshot->complete) {
    return cursor_failure(sourceResponseRef, @"unavailable",
                          @"Current complete inventory недоступен");
  }
  if (!snapshot_matches_request(snapshot, trustedGeneration, inventoryId,
                                inventoryRevision,
                                displayLayoutRevision)) {
    return cursor_failure(sourceResponseRef, @"stale-inventory",
                          @"Current inventory identity или revision изменились");
  }
  if (!valid_displays(snapshot)) {
    return cursor_failure(sourceResponseRef, @"unavailable",
                          @"Current inventory не содержит полный unique display set");
  }

  MetaTopologyProbe before = {0};
  MetaCursorTopologyState topology =
      probe_topology(backend, snapshot, &before);
  if (topology != MetaCursorTopologyCurrent) {
    return cursor_failure(
        sourceResponseRef,
        topology == MetaCursorTopologyStale ? @"stale-inventory"
                                            : @"unavailable",
        topology == MetaCursorTopologyStale
            ? @"Display topology больше не совпадает с bound inventory"
            : @"Fresh display topology недоступна");
  }

  double x = 0;
  double y = 0;
  if (!backend.read_cursor(backend.context, &x, &y) || !isfinite(x) ||
      !isfinite(y)) {
    return cursor_failure(sourceResponseRef, @"unavailable",
                          @"Passive cursor location недоступна");
  }
  size_t matchCount = 0;
  MetaDisplayRecord retainedDisplay = {0};
  for (size_t index = 0; index < snapshot->display_count; index += 1) {
    if (contains_point(snapshot->displays[index].bounds, x, y)) {
      retainedDisplay = snapshot->displays[index];
      matchCount += 1;
    }
  }

  MetaTopologyProbe after = {0};
  topology = probe_topology(backend, snapshot, &after);
  if (topology != MetaCursorTopologyCurrent ||
      after.observed_at_unix_micros < before.observed_at_unix_micros) {
    return cursor_failure(
        sourceResponseRef,
        topology == MetaCursorTopologyStale ? @"stale-inventory"
                                            : @"unavailable",
        topology == MetaCursorTopologyStale
            ? @"Display topology изменилась во время cursor read"
            : @"Display topology continuity не подтверждена после cursor read");
  }
  const MetaInventorySnapshot *current = backend.snapshot(backend.context);
  if (!snapshot_matches_request(current, trustedGeneration, inventoryId,
                                inventoryRevision,
                                displayLayoutRevision) ||
      current->display_topology_epoch != snapshot->display_topology_epoch) {
    return cursor_failure(sourceResponseRef, @"stale-inventory",
                          @"Inventory изменилась во время cursor read");
  }
  if (!current->complete || !valid_displays(current)) {
    return cursor_failure(sourceResponseRef, @"unavailable",
                          @"Inventory continuity стала неполной");
  }
  const MetaDisplayRecord *retainedCurrent = NULL;
  for (size_t index = 0; index < current->display_count; index += 1) {
    if (strcmp(current->displays[index].display_ref,
               retainedDisplay.display_ref) == 0) {
      retainedCurrent = &current->displays[index];
      break;
    }
  }
  if (matchCount == 0) {
    return cursor_failure(sourceResponseRef, @"unavailable",
                          @"Cursor не принадлежит ни одному display bounds");
  }
  if (matchCount != 1) {
    return cursor_failure(sourceResponseRef, @"ambiguous",
                          @"Cursor принадлежит нескольким display bounds");
  }
  if (retainedCurrent == NULL ||
      !same_display(&retainedDisplay, retainedCurrent)) {
    return cursor_failure(sourceResponseRef, @"stale-inventory",
                          @"Resolved display изменился во время cursor read");
  }
  NSDictionary *displayRef = @{
    @"runtimeEpoch" : trustedGeneration[@"runtimeEpoch"],
    @"loginSessionId" : trustedGeneration[@"loginSessionId"],
    @"nativeGeneration" : trustedGeneration[@"nativeGeneration"],
    @"displayRef" : @(retainedDisplay.display_ref),
    @"displayLayoutRevision" : @(displayLayoutRevision),
  };
  return @{
    @"status" : @"resolved",
    @"sourceResponseRef" : sourceResponseRef,
    @"runtimeEpoch" : trustedGeneration[@"runtimeEpoch"],
    @"loginSessionId" : trustedGeneration[@"loginSessionId"],
    @"nativeGeneration" : trustedGeneration[@"nativeGeneration"],
    @"inventoryId" : inventoryId,
    @"inventoryRevision" : @(inventoryRevision),
    @"displayLayoutRevision" : @(displayLayoutRevision),
    @"observedAt" : iso_from_micros(after.observed_at_unix_micros),
    @"cursor" : @{ @"x" : @(x), @"y" : @(y) },
    @"displayRef" : displayRef,
  };
}

static const MetaInventorySnapshot *system_snapshot(void *context) {
  return meta_macos_backend_snapshot((MetaMacOSBackend *)context);
}

static bool system_probe_topology(void *context,
                                  const MetaInventorySnapshot *snapshot,
                                  MetaTopologyProbe *output) {
  return meta_macos_probe_topology((MetaMacOSBackend *)context, snapshot,
                                   output);
}

static bool system_topology_epoch(void *context, uint64_t *epoch) {
  return meta_macos_display_topology_epoch((MetaMacOSBackend *)context, epoch);
}

static bool system_read_cursor(void *context, double *x, double *y) {
  (void)context;
  CGEventRef event = CGEventCreate(NULL);
  if (event == NULL) return false;
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  *x = point.x;
  *y = point.y;
  return true;
}

NSDictionary *meta_cursor_display_read(
    MetaMacOSBackend *owner,
    NSDictionary *trustedGeneration,
    NSString *inventoryId,
    uint64_t inventoryRevision,
    uint64_t displayLayoutRevision) {
  if (owner == NULL) return nil;
  return meta_cursor_display_read_with_backend(
      trustedGeneration, inventoryId, inventoryRevision,
      displayLayoutRevision,
      (MetaCursorDisplayBackend){
          .context = owner,
          .snapshot = system_snapshot,
          .probe_topology = system_probe_topology,
          .current_topology_epoch = system_topology_epoch,
          .read_cursor = system_read_cursor,
      });
}
