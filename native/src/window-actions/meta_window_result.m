#include "meta_window_result.h"

#include <math.h>
#include <string.h>

#include "meta_serialization.h"

static BOOL valid_identifier(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 ||
      value.length >= META_NATIVE_REF_CAPACITY) {
    return NO;
  }
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  unichar first = [value characterAtIndex:0];
  const BOOL valid_first =
      (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
      (first >= '0' && first <= '9');
  return valid_first &&
         [value rangeOfCharacterFromSet:allowed.invertedSet].location ==
             NSNotFound;
}

static NSDictionary *inventory_value(const MetaInventorySnapshot *snapshot,
                                     NSString *source_response_ref) {
  CFDataRef raw = meta_inventory_copy_json(
      snapshot, source_response_ref.UTF8String);
  if (raw == NULL) return nil;
  NSData *data = CFBridgingRelease(raw);
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0
                                                error:&error];
  return error == nil && [value isKindOfClass:NSDictionary.class] ? value
                                                                  : nil;
}

static const MetaWindowRecord *current_window(
    const MetaInventorySnapshot *snapshot,
    const MetaWindowRecord *original) {
  for (size_t index = 0; index < snapshot->window_count; index += 1) {
    const MetaWindowRecord *candidate = &snapshot->windows[index];
    if (candidate->surface_kind == META_SURFACE_WINDOW &&
        candidate->pid == original->pid &&
        strcmp(candidate->window_ref, original->window_ref) == 0 &&
        strcmp(candidate->application_ref, original->application_ref) == 0) {
      return candidate;
    }
  }
  return NULL;
}

static NSDictionary *serialized_window(NSDictionary *inventory,
                                       const MetaWindowRecord *original) {
  NSArray *windows = inventory[@"windows"];
  if (![windows isKindOfClass:NSArray.class]) return nil;
  for (id value in windows) {
    if (![value isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *window = value;
    if ([window[@"kind"] isEqual:@"ax-window"] &&
        [window[@"windowRef"] isEqual:@(original->window_ref)] &&
        [window[@"applicationRef"] isEqual:@(original->application_ref)] &&
        [window[@"ownerPid"] intValue] == original->pid) {
      return window;
    }
  }
  return nil;
}

static NSDictionary *serialized_surface(NSDictionary *window,
                                        const MetaWindowRecord *original,
                                        const char *surface_ref) {
  if (surface_ref[0] == '\0') return nil;
  NSArray *surfaces = window[@"surfaces"];
  if (![surfaces isKindOfClass:NSArray.class]) return nil;
  for (id value in surfaces) {
    if (![value isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *surface = value;
    if ([surface[@"surfaceRef"] isEqual:@(surface_ref)] &&
        [surface[@"ownerWindowRef"] isEqual:@(original->window_ref)] &&
        [surface[@"applicationRef"] isEqual:@(original->application_ref)] &&
        [surface[@"ownerPid"] intValue] == original->pid) {
      return surface;
    }
  }
  return nil;
}

static BOOL same_rect(MetaRect left, MetaRect right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

static BOOL observable_state_changed(const MetaWindowRecord *original,
                                     const MetaWindowRecord *actual) {
  return !same_rect(original->frame, actual->frame) ||
         original->application_hidden != actual->application_hidden ||
         original->minimized != actual->minimized ||
         original->on_screen != actual->on_screen ||
         original->space_visibility != actual->space_visibility ||
         original->fullscreen != actual->fullscreen ||
         original->focused != actual->focused ||
         original->main != actual->main;
}

static NSString *partial_reason(const MetaWindowTransition *transition,
                                BOOL has_new_surface) {
  if (transition->presence == META_WINDOW_PRESENCE_UNKNOWN) {
    return @"Fresh window readback не подтвердил состояние target";
  }
  if (has_new_surface) {
    return @"Окно осталось открытым; появилась принадлежащая ему surface";
  }
  switch (transition->status) {
    case META_TRANSITION_TARGET_STALE:
      return @"Window target устарел до завершения readback";
    case META_TRANSITION_SPACE_UNAVAILABLE:
      return @"macOS не подтвердила переход окна в текущий Space";
    case META_TRANSITION_TIMED_OUT:
      return @"Window transition превысил bounded readback timeout";
    case META_TRANSITION_UNAVAILABLE:
      return @"Window transition недоступен для exact target";
    case META_TRANSITION_PARTIAL:
      return @"Window transition выполнен частично";
    case META_TRANSITION_SUCCEEDED:
      return @"Window transition readback не согласован с результатом";
  }
  return @"Window transition вернул неизвестный status";
}

NSDictionary *meta_window_transition_value(
    const MetaInventorySnapshot *snapshot,
    const MetaWindowRecord *original,
    const MetaWindowTransition *transition,
    NSDictionary *status,
    NSString *sourceResponseRef) {
  if (snapshot == NULL || original == NULL || transition == NULL ||
      ![status isKindOfClass:NSDictionary.class] ||
      !valid_identifier(sourceResponseRef) || original->pid <= 0 ||
      original->surface_kind != META_SURFACE_WINDOW ||
      original->window_ref[0] == '\0' || original->application_ref[0] == '\0' ||
      strcmp(transition->window_ref, original->window_ref) != 0) {
    return nil;
  }
  NSDictionary *inventory = inventory_value(snapshot, sourceResponseRef);
  if (inventory == nil) return nil;
  NSArray *displays = inventory[@"displays"];
  NSString *inventory_id = inventory[@"inventoryId"];
  NSNumber *revision = inventory[@"revision"];
  NSNumber *layout_revision = inventory[@"displayLayoutRevision"];
  NSString *observed_at = inventory[@"capturedAt"];
  if (![displays isKindOfClass:NSArray.class] ||
      !valid_identifier(inventory_id) ||
      ![revision isKindOfClass:NSNumber.class] ||
      ![layout_revision isKindOfClass:NSNumber.class] ||
      ![observed_at isKindOfClass:NSString.class]) {
    return nil;
  }

  const MetaWindowRecord *actual_record = current_window(snapshot, original);
  NSDictionary *actual = nil;
  NSDictionary *new_surface = nil;
  BOOL changed = NO;
  BOOL partial = NO;
  NSArray *errors = @[];
  if (transition->presence == META_WINDOW_PRESENCE_CLOSED) {
    if (!snapshot->complete || !transition->close_succeeded ||
        actual_record != NULL || transition->new_surface_ref[0] != '\0') {
      return nil;
    }
    actual = @{
      @"kind" : @"closed",
      @"windowRef" : @(original->window_ref),
      @"applicationRef" : @(original->application_ref),
      @"ownerPid" : @(original->pid),
      @"absence" : @"confirmed",
    };
    changed = YES;
  } else if (transition->presence == META_WINDOW_PRESENCE_EXISTING) {
    if (actual_record == NULL || transition->close_succeeded) return nil;
    actual = serialized_window(inventory, original);
    if (actual == nil) return nil;
    if (transition->new_surface_ref[0] != '\0') {
      if (!transition->modal_or_sheet_observed) return nil;
      new_surface = serialized_surface(actual, original,
                                       transition->new_surface_ref);
      if (new_surface == nil) return nil;
    } else if (transition->modal_or_sheet_observed) {
      return nil;
    }
    changed = observable_state_changed(original, actual_record) ||
              new_surface != nil;
    partial = transition->status != META_TRANSITION_SUCCEEDED ||
              new_surface != nil;
    if (partial) errors = @[partial_reason(transition, new_surface != nil)];
  } else if (transition->presence == META_WINDOW_PRESENCE_UNKNOWN) {
    if (transition->close_succeeded || transition->new_surface_ref[0] != '\0' ||
        transition->modal_or_sheet_observed) {
      return nil;
    }
    NSString *reason = partial_reason(transition, NO);
    actual = @{
      @"kind" : @"unknown",
      @"windowRef" : @(original->window_ref),
      @"applicationRef" : @(original->application_ref),
      @"ownerPid" : @(original->pid),
      @"reason" : reason,
    };
    partial = YES;
    errors = @[reason];
  } else {
    return nil;
  }

  NSMutableDictionary *result = [@{
    @"sourceResponseRef" : [sourceResponseRef copy],
    @"inventoryId" : inventory_id,
    @"inventoryRevision" : revision,
    @"displayLayoutRevision" : layout_revision,
    @"observedAt" : observed_at,
    @"displays" : displays,
    @"targetRef" : @(original->window_ref),
    @"actual" : actual,
    @"changed" : @(changed),
    @"partial" : @(partial),
    @"errors" : errors,
    @"status" : [status copy],
  } mutableCopy];
  if (new_surface != nil) result[@"newSurface"] = new_surface;
  return result;
}
