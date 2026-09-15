#include "meta_ax_retained_snapshot.h"

static BOOL identifier(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0 ||
      [value length] > maximum) {
    return NO;
  }
  NSData *data = [value dataUsingEncoding:NSASCIIStringEncoding];
  if (data == nil || data.length != [value length]) return NO;
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"];
  return [value rangeOfCharacterFromSet:allowed.invertedSet].location ==
         NSNotFound;
}

static id immutable_json_copy(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:0
                                                   error:NULL];
  return data == nil
             ? nil
             : [NSJSONSerialization JSONObjectWithData:data
                                                options:0
                                                  error:NULL];
}

static BOOL valid_target(NSDictionary *target) {
  if (![target isKindOfClass:NSDictionary.class] || target.count != 2 ||
      ![@[@"window", @"surface"] containsObject:target[@"kind"]] ||
      ![target[@"ref"] isKindOfClass:NSDictionary.class]) {
    return NO;
  }
  NSDictionary *ref = target[@"ref"];
  NSMutableSet<NSString *> *allowed = [NSMutableSet setWithArray:@[
    @"runtimeEpoch", @"loginSessionId", @"nativeGeneration",
    @"applicationRef",
  ]];
  [allowed addObject:[target[@"kind"] isEqual:@"window"]
                         ? @"windowRef"
                         : @"surfaceRef"];
  if ([target[@"kind"] isEqual:@"surface"])
    [allowed addObject:@"ownerWindowRef"];
  for (NSString *key in ref) if (![allowed containsObject:key]) return NO;
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (!identifier(ref[key], 64)) return NO;
  }
  if (!identifier(ref[@"applicationRef"], 127)) return NO;
  if ([target[@"kind"] isEqual:@"window"]) {
    return ref.count == 5 && identifier(ref[@"windowRef"], 127);
  }
  return (ref.count == 5 || ref.count == 6) &&
         identifier(ref[@"surfaceRef"], 127) &&
         (ref[@"ownerWindowRef"] == nil ||
          identifier(ref[@"ownerWindowRef"], 127));
}

static BOOL valid_element_ref(NSDictionary *elementRef) {
  if (![elementRef isKindOfClass:NSDictionary.class] ||
      elementRef.count != 6) {
    return NO;
  }
  for (NSString *key in
       @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (!identifier(elementRef[key], 64)) return NO;
  }
  return identifier(elementRef[@"applicationRef"], 127) &&
         identifier(elementRef[@"snapshotId"], 127) &&
         identifier(elementRef[@"elementRef"], 127);
}

static NSString *target_key(NSDictionary *target) {
  if (!valid_target(target)) return nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:target
                                                 options:NSJSONWritingSortedKeys
                                                   error:NULL];
  return data == nil
             ? nil
             : [[NSString alloc] initWithData:data
                                      encoding:NSUTF8StringEncoding];
}

static BOOL same_element_authority(NSDictionary *elementRef,
                                   NSDictionary *target,
                                   NSString *snapshotId) {
  NSDictionary *ref = target[@"ref"];
  return [elementRef[@"runtimeEpoch"] isEqual:ref[@"runtimeEpoch"]] &&
         [elementRef[@"loginSessionId"] isEqual:ref[@"loginSessionId"]] &&
         [elementRef[@"nativeGeneration"]
             isEqual:ref[@"nativeGeneration"]] &&
         [elementRef[@"applicationRef"] isEqual:ref[@"applicationRef"]] &&
         [elementRef[@"snapshotId"] isEqual:snapshotId];
}

static NSArray<NSString *> *valid_actions(id value) {
  if (![value isKindOfClass:NSArray.class] || [value count] > 64) return nil;
  NSMutableOrderedSet<NSString *> *actions = [NSMutableOrderedSet orderedSet];
  for (id action in value) {
    if (![action isKindOfClass:NSString.class] || [action length] == 0 ||
        [action length] > 128 || [actions containsObject:action]) {
      return nil;
    }
    [actions addObject:[action copy]];
  }
  return actions.array;
}

@interface MetaAXRetainedSnapshotEntry : NSObject
@property(nonatomic, copy) NSDictionary *target;
@property(nonatomic, copy) NSString *inventoryId;
@property(nonatomic) uint64_t inventoryRevision;
@property(nonatomic, copy) NSString *snapshotId;
@property(nonatomic, copy) NSDictionary<NSString *, id> *elements;
@property(nonatomic, copy)
    NSDictionary<NSString *, NSArray<NSString *> *> *actions;
@property(nonatomic) uint64_t expiresAt;
@property(nonatomic) uint64_t sequence;
@end

@implementation MetaAXRetainedSnapshotEntry
@end

@implementation MetaAXRetainedSnapshotRegistry {
  NSLock *_lock;
  uint64_t (^_clock)(void);
  uint64_t _ttlMillis;
  NSUInteger _maxSnapshots;
  NSUInteger _maxNodes;
  NSUInteger _nodeCount;
  uint64_t _sequence;
  NSMutableDictionary<NSString *, MetaAXRetainedSnapshotEntry *> *_snapshots;
}

- (instancetype)initWithClock:(uint64_t (^)(void))clock
                     ttlMillis:(uint64_t)ttlMillis
                  maxSnapshots:(NSUInteger)maxSnapshots
                      maxNodes:(NSUInteger)maxNodes {
  if (clock == nil || ttlMillis == 0 || ttlMillis > 120000 ||
      maxSnapshots == 0 || maxSnapshots > 64 || maxNodes == 0 ||
      maxNodes > 1500) {
    return nil;
  }
  self = [super init];
  if (self) {
    _clock = [clock copy];
    _ttlMillis = ttlMillis;
    _maxSnapshots = maxSnapshots;
    _maxNodes = maxNodes;
    _lock = [[NSLock alloc] init];
    _snapshots = [NSMutableDictionary dictionary];
  }
  return self;
}

- (BOOL)publishTarget:(NSDictionary *)target
           inventoryId:(NSString *)inventoryId
     inventoryRevision:(uint64_t)inventoryRevision
             snapshotId:(NSString *)snapshotId
                  nodes:(NSArray<NSDictionary *> *)nodes
       borrowedElements:(NSDictionary<NSString *, id> *)borrowedElements {
  NSString *key = target_key(target);
  if (key == nil || !identifier(inventoryId, 127) ||
      !identifier(snapshotId, 127) ||
      inventoryRevision > 9007199254740991ULL ||
      ![nodes isKindOfClass:NSArray.class] || nodes.count > _maxNodes ||
      ![borrowedElements isKindOfClass:NSDictionary.class]) {
    return NO;
  }
  NSMutableDictionary<NSString *, id> *retained =
      [NSMutableDictionary dictionary];
  NSMutableDictionary<NSString *, NSArray<NSString *> *> *actionsByRef =
      [NSMutableDictionary dictionary];
  for (NSDictionary *node in nodes) {
    if (![node isKindOfClass:NSDictionary.class] ||
        !identifier(node[@"elementRef"], 127) ||
        retained[node[@"elementRef"]] != nil) {
      return NO;
    }
    id element = borrowedElements[node[@"elementRef"]];
    NSArray<NSString *> *actions = valid_actions(node[@"actions"]);
    if (element == nil || actions == nil) return NO;
    retained[node[@"elementRef"]] = element;
    actionsByRef[node[@"elementRef"]] = actions;
  }
  const uint64_t now = _clock();
  if (now > UINT64_MAX - _ttlMillis) return NO;
  MetaAXRetainedSnapshotEntry *entry = [MetaAXRetainedSnapshotEntry new];
  entry.target = immutable_json_copy(target);
  entry.inventoryId = [inventoryId copy];
  entry.inventoryRevision = inventoryRevision;
  entry.snapshotId = [snapshotId copy];
  entry.elements = retained;
  entry.actions = actionsByRef;
  entry.expiresAt = now + _ttlMillis;

  [_lock lock];
  [self pruneExpiredAt:now];
  [self removeSnapshotForKey:key];
  while ((_snapshots.count >= _maxSnapshots ||
          _nodeCount + retained.count > _maxNodes) &&
         _snapshots.count > 0) {
    NSString *oldestKey = nil;
    uint64_t oldestSequence = UINT64_MAX;
    for (NSString *candidateKey in _snapshots) {
      MetaAXRetainedSnapshotEntry *candidate = _snapshots[candidateKey];
      if (candidate.sequence < oldestSequence) {
        oldestSequence = candidate.sequence;
        oldestKey = candidateKey;
      }
    }
    [self removeSnapshotForKey:oldestKey];
  }
  if (_snapshots.count >= _maxSnapshots ||
      _nodeCount + retained.count > _maxNodes) {
    [_lock unlock];
    return NO;
  }
  entry.sequence = ++_sequence;
  _snapshots[key] = entry;
  _nodeCount += retained.count;
  [_lock unlock];
  return YES;
}

- (MetaAXRetainedBorrowStatus)withPressElement:(NSDictionary *)elementRef
                                        target:(NSDictionary *)target
                                   inventoryId:(NSString *)inventoryId
                             inventoryRevision:(uint64_t)inventoryRevision
                                       consume:(MetaAXRetainedElementConsumer)consume {
  NSString *key = target_key(target);
  if (key == nil || !valid_element_ref(elementRef) ||
      !identifier(inventoryId, 127) ||
      inventoryRevision > 9007199254740991ULL || consume == nil) {
    return META_AX_RETAINED_BORROW_INVALID_REQUEST;
  }
  const uint64_t now = _clock();
  [_lock lock];
  [self pruneExpiredAt:now];
  MetaAXRetainedSnapshotEntry *entry = _snapshots[key];
  if (entry == nil || inventoryRevision < entry.inventoryRevision ||
      !same_element_authority(elementRef, target, entry.snapshotId)) {
    [_lock unlock];
    return META_AX_RETAINED_BORROW_SNAPSHOT_STALE;
  }
  NSString *rawRef = elementRef[@"elementRef"];
  id element = entry.elements[rawRef];
  NSArray<NSString *> *actions = entry.actions[rawRef];
  if (element == nil) {
    [_lock unlock];
    return META_AX_RETAINED_BORROW_SNAPSHOT_STALE;
  }
  if (![actions containsObject:@"AXPress"]) {
    [_lock unlock];
    return META_AX_RETAINED_BORROW_ACTION_UNAVAILABLE;
  }
  BOOL accepted = consume(element);
  [_lock unlock];
  return accepted ? META_AX_RETAINED_BORROW_OK
                  : META_AX_RETAINED_BORROW_CONSUMER_FAILED;
}

- (void)invalidateTarget:(NSDictionary *)target {
  NSString *key = target_key(target);
  if (key == nil) return;
  [_lock lock];
  [self removeSnapshotForKey:key];
  [_lock unlock];
}

- (void)invalidateAll {
  [_lock lock];
  [_snapshots removeAllObjects];
  _nodeCount = 0;
  [_lock unlock];
}

- (void)pruneExpiredAt:(uint64_t)now {
  for (NSString *key in _snapshots.allKeys) {
    if (_snapshots[key].expiresAt <= now) [self removeSnapshotForKey:key];
  }
}

- (void)removeSnapshotForKey:(NSString *)key {
  MetaAXRetainedSnapshotEntry *entry = _snapshots[key];
  if (entry == nil) return;
  NSUInteger count = entry.elements.count;
  _nodeCount = count > _nodeCount ? 0 : _nodeCount - count;
  [_snapshots removeObjectForKey:key];
}

@end
