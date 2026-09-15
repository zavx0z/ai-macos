#include "meta_ax_inspector.h"

#include <math.h>
#include <time.h>

static const NSUInteger META_AX_CHILD_BATCH = 32;
static const NSUInteger META_AX_ERROR_LIMIT = 128;
static const NSUInteger META_AX_NODE_LIMIT = 1500;
static const NSUInteger META_AX_BYTE_LIMIT = 1024 * 1024;

static BOOL identifier(const char *value, size_t maximum) {
  if (value == NULL) return NO;
  const size_t length = strnlen(value, maximum + 1);
  return length > 0 && length <= maximum;
}

static NSString *bounded_string(NSString *value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class]) return @"";
  if (value.length <= maximum) return [value copy];
  __block NSUInteger end = 0;
  [value enumerateSubstringsInRange:NSMakeRange(0, value.length)
                            options:NSStringEnumerationByComposedCharacterSequences
                         usingBlock:^(__unused NSString *substring,
                                      NSRange substringRange,
                                      __unused NSRange enclosingRange,
                                      BOOL *stop) {
    if (NSMaxRange(substringRange) > maximum) {
      *stop = YES;
      return;
    }
    end = NSMaxRange(substringRange);
  }];
  return [value substringToIndex:end];
}

static void add_error(NSMutableArray<NSString *> *errors, NSString *message) {
  if (errors.count >= META_AX_ERROR_LIMIT) return;
  [errors addObject:bounded_string(message, 2048)];
}

static BOOL deadline_reached(id<MetaAXInspectionBackend> backend,
                             MetaAXInspectionContext context) {
  return [backend monotonicMillis] >= context.deadline_millis;
}

static BOOL finite_rect(CGRect value) {
  return isfinite(value.origin.x) && isfinite(value.origin.y) &&
         isfinite(value.size.width) && isfinite(value.size.height);
}

static NSString *status_name(MetaAXReadStatus status) {
  if (status == META_AX_READ_TIMED_OUT) return @"timed out";
  if (status == META_AX_READ_FAILED) return @"failed";
  return @"unavailable";
}

static NSString *read_string(id<MetaAXInspectionBackend> backend,
                             id element,
                             NSString *attribute,
                             NSUInteger maximum,
                             BOOL required,
                             MetaAXReadStatus *readStatus,
                             BOOL *complete,
                             NSMutableArray<NSString *> *errors,
                             MetaAXInspectionContext context) {
  if (deadline_reached(backend, context)) {
    if (readStatus != NULL) *readStatus = META_AX_READ_TIMED_OUT;
    *complete = NO;
    add_error(errors, @"AX total deadline exceeded");
    return @"";
  }
  NSString *value = nil;
  MetaAXReadStatus status = [backend stringAttribute:attribute
                                          forElement:element
                                               value:&value];
  if (deadline_reached(backend, context)) status = META_AX_READ_TIMED_OUT;
  if (readStatus != NULL) *readStatus = status;
  if (status == META_AX_READ_OK && [value isKindOfClass:NSString.class]) {
    if (value.length > maximum) {
      *complete = NO;
      add_error(errors, [NSString stringWithFormat:@"AX %@ exceeded output limit", attribute]);
    }
    return bounded_string(value, maximum);
  }
  if (status != META_AX_READ_ABSENT || required) {
    *complete = NO;
    add_error(errors, [NSString stringWithFormat:@"AX %@ %@", attribute, status_name(status)]);
  }
  return @"";
}

static id read_value(id<MetaAXInspectionBackend> backend,
                     id element,
                     BOOL *complete,
                     NSMutableArray<NSString *> *errors,
                     MetaAXInspectionContext context) {
  if (deadline_reached(backend, context)) {
    *complete = NO;
    add_error(errors, @"AX total deadline exceeded");
    return nil;
  }
  id value = nil;
  MetaAXReadStatus status = [backend valueForElement:element value:&value];
  if (deadline_reached(backend, context)) status = META_AX_READ_TIMED_OUT;
  if (status == META_AX_READ_ABSENT) return nil;
  if (status != META_AX_READ_OK || value == nil) {
    *complete = NO;
    add_error(errors, [NSString stringWithFormat:@"AX value %@",
                                                 status_name(status)]);
    return nil;
  }
  CFTypeID type = CFGetTypeID((__bridge CFTypeRef)value);
  if (type == CFStringGetTypeID()) {
    NSString *text = value;
    if (text.length > 4096) {
      *complete = NO;
      add_error(errors, @"AX value exceeded output limit");
    }
    return bounded_string(text, 4096);
  }
  if (type == CFBooleanGetTypeID()) return @([value boolValue]);
  if (type == CFNumberGetTypeID() && isfinite([value doubleValue])) {
    return [value copy];
  }
  *complete = NO;
  add_error(errors, @"AX value contained unsupported scalar type");
  return nil;
}

static BOOL value_must_be_redacted(NSString *role,
                                   MetaAXReadStatus roleStatus,
                                   NSString *subrole,
                                   MetaAXReadStatus subroleStatus,
                                   BOOL *uncertain) {
  *uncertain = NO;
  if (subroleStatus == META_AX_READ_OK &&
      [subrole isEqual:(__bridge NSString *)kAXSecureTextFieldSubrole]) {
    return YES;
  }
  if (roleStatus != META_AX_READ_OK || role.length == 0) {
    *uncertain = YES;
    return YES;
  }
  BOOL textField =
      [role isEqual:(__bridge NSString *)kAXTextFieldRole] ||
      [role isEqual:(__bridge NSString *)kAXTextAreaRole];
  if (textField && subroleStatus != META_AX_READ_OK &&
      subroleStatus != META_AX_READ_ABSENT) {
    *uncertain = YES;
    return YES;
  }
  return NO;
}

static NSArray<NSString *> *read_actions(
    id<MetaAXInspectionBackend> backend,
    id element,
    BOOL *complete,
    NSMutableArray<NSString *> *errors,
    MetaAXInspectionContext context) {
  if (deadline_reached(backend, context)) {
    *complete = NO;
    add_error(errors, @"AX total deadline exceeded");
    return @[];
  }
  NSArray<NSString *> *raw = nil;
  MetaAXReadStatus status = [backend actionsForElement:element value:&raw];
  if (deadline_reached(backend, context)) status = META_AX_READ_TIMED_OUT;
  if (status == META_AX_READ_ABSENT) return @[];
  if (status != META_AX_READ_OK || ![raw isKindOfClass:NSArray.class]) {
    *complete = NO;
    add_error(errors, [NSString stringWithFormat:@"AX actions %@", status_name(status)]);
    return @[];
  }
  NSMutableOrderedSet<NSString *> *actions = [NSMutableOrderedSet orderedSet];
  for (id value in raw) {
    if (![value isKindOfClass:NSString.class] || [value length] == 0) {
      *complete = NO;
      add_error(errors, @"AX actions contained invalid value");
      continue;
    }
    if (actions.count >= 64) {
      *complete = NO;
      add_error(errors, @"AX actions exceeded output limit");
      break;
    }
    [actions addObject:bounded_string(value, 128)];
    if ([value length] > 128) {
      *complete = NO;
      add_error(errors, @"AX action exceeded output limit");
    }
  }
  return actions.array;
}

static NSDictionary *result_dictionary(NSString *snapshotId,
                                       NSArray<NSDictionary *> *nodes,
                                       NSArray<NSString *> *errors,
                                       BOOL complete,
                                       NSUInteger encodedBytes) {
  return @{
    @"snapshotId": snapshotId,
    @"complete": @(complete),
    @"nodeCount": @(nodes.count),
    @"encodedBytes": @(encodedBytes),
    @"nodes": nodes,
    @"errors": errors,
  };
}

static NSDictionary *finalize_result(NSString *snapshotId,
                                     NSMutableArray<NSDictionary *> *nodes,
                                     NSMutableArray<NSString *> *errors,
                                     BOOL complete,
                                     NSUInteger maximumBytes) {
  BOOL budgetErrorAdded = NO;
  while (YES) {
    NSUInteger encodedBytes = 0;
    NSDictionary *result = nil;
    for (NSUInteger attempt = 0; attempt < 4; attempt += 1) {
      result = result_dictionary(snapshotId, nodes, errors, complete, encodedBytes);
      NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
      if (encoded == nil) return nil;
      if (encoded.length == encodedBytes) break;
      encodedBytes = encoded.length;
    }
    result = result_dictionary(snapshotId, nodes, errors, complete, encodedBytes);
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (encoded != nil && encoded.length <= maximumBytes) {
      if (encoded.length != encodedBytes) {
        result = result_dictionary(snapshotId, nodes, errors, complete, encoded.length);
      }
      return result;
    }
    complete = NO;
    if (!budgetErrorAdded) {
      add_error(errors, @"AX result exceeded byte budget");
      budgetErrorAdded = YES;
    }
    if (nodes.count > 0) {
      [nodes removeLastObject];
      continue;
    }
    if (errors.count > 1) {
      [errors removeObjectAtIndex:0];
      continue;
    }
    return nil;
  }
}

NSDictionary *meta_ax_inspect_with_backend(
    id borrowedRoot,
    MetaAXInspectionContext context,
    id<MetaAXInspectionBackend> backend) {
  return meta_ax_inspect_with_backend_and_observer(
      borrowedRoot, context, backend, nil);
}

NSDictionary *meta_ax_inspect_with_backend_and_observer(
    id borrowedRoot,
    MetaAXInspectionContext context,
    id<MetaAXInspectionBackend> backend,
    MetaAXInspectionNodeObserver observer) {
  if (borrowedRoot == nil || backend == nil ||
      !identifier(context.runtime_epoch, 64) ||
      !identifier(context.login_session_id, 64) ||
      !identifier(context.native_generation, 64) ||
      !identifier(context.application_ref, 127) ||
      !identifier(context.inventory_id, 127) ||
      !identifier(context.snapshot_id, 127) ||
      !identifier(context.target_ref, 127) || context.owner_pid <= 0 ||
      context.depth > 12 || context.max_nodes == 0 ||
      context.max_nodes > META_AX_NODE_LIMIT || context.max_bytes == 0 ||
      context.max_bytes > META_AX_BYTE_LIMIT || context.deadline_millis == 0 ||
      context.per_call_timeout_millis == 0 ||
      context.per_call_timeout_millis > 1000) {
    return nil;
  }

  NSString *snapshotId = @(context.snapshot_id);
  NSMutableArray<NSDictionary *> *nodes = [NSMutableArray array];
  NSMutableArray<NSString *> *errors = [NSMutableArray array];
  BOOL complete = YES;
  pid_t ownerPid = 0;
  if (deadline_reached(backend, context)) {
    add_error(errors, @"AX total deadline exceeded before target validation");
    return finalize_result(snapshotId, nodes, errors, NO, context.max_bytes);
  }
  MetaAXReadStatus ownerStatus = [backend ownerPidForElement:borrowedRoot value:&ownerPid];
  if (deadline_reached(backend, context)) ownerStatus = META_AX_READ_TIMED_OUT;
  if (ownerStatus != META_AX_READ_OK || ownerPid != context.owner_pid) {
    add_error(errors, @"AX borrowed root owner PID mismatch");
    return finalize_result(snapshotId, nodes, errors, NO, context.max_bytes);
  }

  NSMutableArray<NSDictionary *> *pending = [NSMutableArray arrayWithObject:@{
    @"element": borrowedRoot,
    @"depth": @0,
    @"elementRef": @"ax-node:1",
  }];
  NSMutableSet *discovered = [NSMutableSet setWithObject:borrowedRoot];
  NSUInteger nextIdentifier = 2;
  NSUInteger cursor = 0;
  NSUInteger nodeBytes = 0;

  while (cursor < pending.count) {
    if (deadline_reached(backend, context)) {
      complete = NO;
      add_error(errors, @"AX total deadline exceeded");
      break;
    }
    if (nodes.count >= context.max_nodes) {
      complete = NO;
      add_error(errors, @"AX node limit reached");
      break;
    }
    NSDictionary *item = pending[cursor++];
    id element = item[@"element"];
    NSString *elementRef = item[@"elementRef"];
    NSUInteger depth = [item[@"depth"] unsignedIntegerValue];
    MetaAXReadStatus roleStatus = META_AX_READ_FAILED;
    MetaAXReadStatus subroleStatus = META_AX_READ_FAILED;
    MetaAXReadStatus identifierStatus = META_AX_READ_FAILED;
    MetaAXReadStatus descriptionStatus = META_AX_READ_FAILED;
    NSString *role = read_string(backend, element, @"role", 128, YES,
                                 &roleStatus, &complete, errors, context);
    NSString *subrole = read_string(backend, element, @"subrole", 128, NO,
                                    &subroleStatus, &complete, errors, context);
    NSString *title = read_string(backend, element, @"title", 4096, NO,
                                  NULL, &complete, errors, context);
    NSString *nodeIdentifier = read_string(
        backend, element, @"identifier", 4096, NO, &identifierStatus,
        &complete, errors, context);
    NSString *nodeDescription = read_string(
        backend, element, @"description", 4096, NO, &descriptionStatus,
        &complete, errors, context);
    NSArray<NSString *> *actions = read_actions(backend, element, &complete,
                                                errors, context);
    NSMutableDictionary *node = [@{
      @"elementRef": elementRef,
      @"role": role,
      @"subrole": subrole,
      @"title": title,
      @"actions": actions,
    } mutableCopy];
    if (item[@"parentElementRef"] != nil) {
      node[@"parentElementRef"] = item[@"parentElementRef"];
    }
    if (identifierStatus == META_AX_READ_OK) {
      node[@"identifier"] = nodeIdentifier;
    }
    if (descriptionStatus == META_AX_READ_OK) {
      node[@"description"] = nodeDescription;
    }
    BOOL redactionUncertain = NO;
    if (value_must_be_redacted(role, roleStatus, subrole, subroleStatus,
                               &redactionUncertain)) {
      node[@"valueRedacted"] = @YES;
      if (redactionUncertain) {
        complete = NO;
        add_error(errors,
                  @"AX value omitted because secure text classification failed");
      }
    } else {
      id value = read_value(backend, element, &complete, errors, context);
      if (value != nil) node[@"value"] = value;
    }
    CGRect frame = CGRectZero;
    MetaAXReadStatus frameStatus = deadline_reached(backend, context)
                                           ? META_AX_READ_TIMED_OUT
                                           : [backend frameForElement:element
                                                               value:&frame];
    if (deadline_reached(backend, context)) frameStatus = META_AX_READ_TIMED_OUT;
    if (frameStatus == META_AX_READ_OK && finite_rect(frame) &&
        frame.size.width >= 0 && frame.size.height >= 0) {
      node[@"frame"] = @{
        @"x": @(frame.origin.x),
        @"y": @(frame.origin.y),
        @"width": @(frame.size.width),
        @"height": @(frame.size.height),
      };
    } else if (frameStatus != META_AX_READ_ABSENT) {
      complete = NO;
      add_error(errors, [NSString stringWithFormat:@"AX frame %@", status_name(frameStatus)]);
    }
    NSData *encodedNode = [NSJSONSerialization dataWithJSONObject:node options:0 error:NULL];
    if (encodedNode == nil || nodeBytes + encodedNode.length + 512 > context.max_bytes) {
      complete = NO;
      add_error(errors, @"AX node exceeded remaining byte budget");
      break;
    }
    if (observer != nil &&
        !observer(elementRef, element, [actions copy])) {
      node[@"actions"] = @[];
      complete = NO;
      add_error(errors, @"AX node retention observer rejected element");
      encodedNode = [NSJSONSerialization dataWithJSONObject:node
                                                    options:0
                                                      error:NULL];
      if (encodedNode == nil ||
          nodeBytes + encodedNode.length + 512 > context.max_bytes) {
        add_error(errors, @"AX retained node exceeded remaining byte budget");
        break;
      }
    }
    [nodes addObject:node];
    nodeBytes += encodedNode.length + 1;

    NSUInteger childCount = 0;
    MetaAXReadStatus countStatus = deadline_reached(backend, context)
                                           ? META_AX_READ_TIMED_OUT
                                           : [backend childCountForElement:element
                                                                   value:&childCount];
    if (countStatus == META_AX_READ_ABSENT) continue;
    if (countStatus != META_AX_READ_OK || deadline_reached(backend, context)) {
      complete = NO;
      add_error(errors, [NSString stringWithFormat:@"AX children %@", status_name(countStatus)]);
      continue;
    }
    if (depth >= context.depth) {
      if (childCount > 0) {
        complete = NO;
        add_error(errors, @"AX depth limit reached before subtree end");
      }
      continue;
    }
    NSUInteger offset = 0;
    while (offset < childCount) {
      const NSUInteger remainingSlots = context.max_nodes - discovered.count;
      if (remainingSlots == 0) {
        complete = NO;
        add_error(errors, @"AX child enumeration reached node limit");
        break;
      }
      const NSUInteger batch = MIN(META_AX_CHILD_BATCH,
                                   MIN(childCount - offset, remainingSlots));
      NSArray *children = nil;
      MetaAXReadStatus childStatus = deadline_reached(backend, context)
                                            ? META_AX_READ_TIMED_OUT
                                            : [backend childrenForElement:element
                                                                     from:offset
                                                                    count:batch
                                                                    value:&children];
      if (childStatus != META_AX_READ_OK || ![children isKindOfClass:NSArray.class] ||
          children.count > batch || deadline_reached(backend, context)) {
        complete = NO;
        add_error(errors, [NSString stringWithFormat:@"AX child batch %@", status_name(childStatus)]);
        break;
      }
      if (children.count == 0) {
        complete = NO;
        add_error(errors, @"AX child batch ended before advertised count");
        break;
      }
      for (id child in children) {
        if (child == nil || [discovered containsObject:child]) {
          complete = NO;
          add_error(errors, @"AX child graph contains cycle or duplicate identity");
          continue;
        }
        [discovered addObject:child];
        NSString *childRef = [NSString stringWithFormat:@"ax-node:%lu",
                              (unsigned long)nextIdentifier++];
        [pending addObject:@{
          @"element": child,
          @"depth": @(depth + 1),
          @"elementRef": childRef,
          @"parentElementRef": elementRef,
        }];
      }
      offset += children.count;
      if (children.count < batch && offset < childCount) {
        complete = NO;
        add_error(errors, @"AX child batch was shorter than advertised count");
        break;
      }
    }
  }
  return finalize_result(snapshotId, nodes, errors, complete,
                         context.max_bytes);
}

@interface MetaAXSystemBackend : NSObject <MetaAXInspectionBackend>
- (instancetype)initWithTimeoutMillis:(uint64_t)timeoutMillis
                        deadlineMillis:(uint64_t)deadlineMillis;
@end

@implementation MetaAXSystemBackend {
  uint64_t _timeoutMillis;
  uint64_t _deadlineMillis;
}

- (instancetype)initWithTimeoutMillis:(uint64_t)timeoutMillis
                        deadlineMillis:(uint64_t)deadlineMillis {
  self = [super init];
  if (self) {
    _timeoutMillis = timeoutMillis;
    _deadlineMillis = deadlineMillis;
  }
  return self;
}

- (uint64_t)monotonicMillis {
  struct timespec value = {0};
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}

- (MetaAXReadStatus)prepare:(id)element value:(AXUIElementRef *)value {
  const uint64_t now = [self monotonicMillis];
  if (now >= _deadlineMillis) return META_AX_READ_TIMED_OUT;
  const uint64_t remaining = _deadlineMillis - now;
  const uint64_t timeout = MIN(_timeoutMillis, remaining);
  *value = (__bridge AXUIElementRef)element;
  return [self statusForError:AXUIElementSetMessagingTimeout(
      *value, (float)((NSTimeInterval)timeout / 1000.0))];
}

- (MetaAXReadStatus)statusForError:(AXError)error {
  if (error == kAXErrorSuccess) return META_AX_READ_OK;
  if (error == kAXErrorNoValue || error == kAXErrorAttributeUnsupported ||
      error == kAXErrorActionUnsupported) return META_AX_READ_ABSENT;
  if (error == kAXErrorCannotComplete) return META_AX_READ_TIMED_OUT;
  return META_AX_READ_FAILED;
}

- (MetaAXReadStatus)ownerPidForElement:(id)element value:(pid_t *)value {
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  return status == META_AX_READ_OK
             ? [self statusForError:AXUIElementGetPid(prepared, value)]
             : status;
}

- (MetaAXReadStatus)stringAttribute:(NSString *)attribute
                         forElement:(id)element
                              value:(NSString **)value {
  NSDictionary<NSString *, NSString *> *attributes = @{
    @"role": (__bridge NSString *)kAXRoleAttribute,
    @"subrole": (__bridge NSString *)kAXSubroleAttribute,
    @"title": (__bridge NSString *)kAXTitleAttribute,
    @"identifier": (__bridge NSString *)kAXIdentifierAttribute,
    @"description": (__bridge NSString *)kAXDescriptionAttribute,
  };
  NSString *name = attributes[attribute];
  if (name == nil) return META_AX_READ_FAILED;
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFTypeRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValue(
      prepared, (__bridge CFStringRef)name, &copied);
  status = [self statusForError:error];
  if (status == META_AX_READ_OK && copied != NULL &&
      CFGetTypeID(copied) == CFStringGetTypeID()) {
    *value = [(__bridge NSString *)copied copy];
  } else if (status == META_AX_READ_OK) {
    status = META_AX_READ_FAILED;
  }
  if (copied != NULL) CFRelease(copied);
  return status;
}

- (MetaAXReadStatus)valueForElement:(id)element value:(id *)value {
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFTypeRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValue(
      prepared, kAXValueAttribute, &copied);
  status = [self statusForError:error];
  if (status == META_AX_READ_OK && copied != NULL) {
    CFTypeID type = CFGetTypeID(copied);
    if (type == CFStringGetTypeID() || type == CFBooleanGetTypeID() ||
        type == CFNumberGetTypeID()) {
      *value = [(__bridge id)copied copy];
    } else {
      status = META_AX_READ_FAILED;
    }
  } else if (status == META_AX_READ_OK) {
    status = META_AX_READ_FAILED;
  }
  if (copied != NULL) CFRelease(copied);
  return status;
}

- (MetaAXReadStatus)frameForElement:(id)element value:(CGRect *)value {
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFTypeRef position = NULL;
  CFTypeRef size = NULL;
  AXError positionError = AXUIElementCopyAttributeValue(
      prepared, kAXPositionAttribute, &position);
  status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) {
    if (position != NULL) CFRelease(position);
    return status;
  }
  AXError sizeError = AXUIElementCopyAttributeValue(
      prepared, kAXSizeAttribute, &size);
  status = [self statusForError:positionError];
  if (status == META_AX_READ_OK) status = [self statusForError:sizeError];
  CGPoint origin = CGPointZero;
  CGSize dimensions = CGSizeZero;
  if (status == META_AX_READ_OK && position != NULL && size != NULL &&
      CFGetTypeID(position) == AXValueGetTypeID() &&
      CFGetTypeID(size) == AXValueGetTypeID() &&
      AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &origin) &&
      AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions)) {
    *value = (CGRect){origin, dimensions};
  } else if (status == META_AX_READ_OK) {
    status = META_AX_READ_FAILED;
  }
  if (position != NULL) CFRelease(position);
  if (size != NULL) CFRelease(size);
  return status;
}

- (MetaAXReadStatus)actionsForElement:(id)element
                                value:(NSArray<NSString *> **)value {
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFArrayRef copied = NULL;
  AXError error = AXUIElementCopyActionNames(prepared, &copied);
  status = [self statusForError:error];
  if (status == META_AX_READ_OK && copied != NULL) {
    *value = [(__bridge NSArray *)copied copy];
  } else if (status == META_AX_READ_OK) {
    status = META_AX_READ_FAILED;
  }
  if (copied != NULL) CFRelease(copied);
  return status;
}

- (MetaAXReadStatus)childCountForElement:(id)element
                                   value:(NSUInteger *)value {
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFIndex count = 0;
  AXError error = AXUIElementGetAttributeValueCount(
      prepared, kAXChildrenAttribute, &count);
  if (error == kAXErrorSuccess && count >= 0) *value = (NSUInteger)count;
  return count < 0 ? META_AX_READ_FAILED : [self statusForError:error];
}

- (MetaAXReadStatus)childrenForElement:(id)element
                                  from:(NSUInteger)index
                                 count:(NSUInteger)count
                                 value:(NSArray **)value {
  if (index > (NSUInteger)LONG_MAX || count > META_AX_CHILD_BATCH) {
    return META_AX_READ_FAILED;
  }
  AXUIElementRef prepared = NULL;
  MetaAXReadStatus status = [self prepare:element value:&prepared];
  if (status != META_AX_READ_OK) return status;
  CFArrayRef copied = NULL;
  AXError error = AXUIElementCopyAttributeValues(
      prepared, kAXChildrenAttribute, (CFIndex)index,
      (CFIndex)count, &copied);
  status = [self statusForError:error];
  if (status == META_AX_READ_OK && copied != NULL) {
    NSArray *children = (__bridge NSArray *)copied;
    for (id child in children) {
      if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) {
        status = META_AX_READ_FAILED;
        break;
      }
    }
    if (status == META_AX_READ_OK) *value = [children copy];
  } else if (status == META_AX_READ_OK) {
    status = META_AX_READ_FAILED;
  }
  if (copied != NULL) CFRelease(copied);
  return status;
}

@end

NSDictionary *meta_ax_inspect_borrowed_element(
    AXUIElementRef borrowedRoot,
    MetaAXInspectionContext context) {
  return meta_ax_inspect_borrowed_element_and_observer(
      borrowedRoot, context, nil);
}

NSDictionary *meta_ax_inspect_borrowed_element_and_observer(
    AXUIElementRef borrowedRoot,
    MetaAXInspectionContext context,
    MetaAXInspectionNodeObserver observer) {
  if (borrowedRoot == NULL || CFGetTypeID(borrowedRoot) != AXUIElementGetTypeID()) {
    return nil;
  }
  MetaAXSystemBackend *backend = [[MetaAXSystemBackend alloc]
      initWithTimeoutMillis:context.per_call_timeout_millis
             deadlineMillis:context.deadline_millis];
  return meta_ax_inspect_with_backend_and_observer(
      (__bridge id)borrowedRoot, context, backend, observer);
}
