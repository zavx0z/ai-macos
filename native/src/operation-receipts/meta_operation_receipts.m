#include "meta_operation_receipts.h"

@implementation MetaOperationReceipts {
  NSMutableDictionary<NSString *, NSDictionary *> *_statuses;
  NSMutableDictionary<NSString *, NSNumber *> *_sizes;
  NSUInteger _bytes;
}
- (instancetype)init {
  self = [super init];
  if (self) { _statuses = [NSMutableDictionary dictionary]; _sizes = [NSMutableDictionary dictionary]; }
  return self;
}
- (BOOL)recordStatus:(NSDictionary *)status {
  if (![status isKindOfClass:NSDictionary.class]) return NO;
  NSSet *keys = [NSSet setWithArray:@[@"requestId", @"operationId", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration",
    @"acceptedFence", @"highWaterFence", @"execution", @"dispatch", @"cleanup", @"lastCheckpoint", @"targetVerified",
    @"cancellationRequested", @"userInterference", @"restorationAllowed", @"quarantined", @"heldCount", @"dispatchAttempts", @"ledgerRevision", @"observer"]];
  for (id key in status) if (![keys containsObject:key]) return NO;
  for (NSString *key in @[@"operationId", @"runtimeEpoch", @"loginSessionId", @"nativeGeneration"]) {
    if (![status[key] isKindOfClass:NSString.class] || [status[key] length] == 0 || [status[key] length] > 127) return NO;
  }
  if (![status[@"acceptedFence"] isKindOfClass:NSDictionary.class] || ![status[@"observer"] isKindOfClass:NSDictionary.class]) return NO;
  // Вложенные metadata также не должны превратиться в хранилище caller payload.
  NSSet *fenceKeys = [NSSet setWithArray:@[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"counter"]];
  NSSet *observerKeys = [NSSet setWithArray:@[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"state", @"coverageStartCursor", @"cursor",
    @"nextSequence", @"startedAt", @"coveredFrom", @"coveredThrough", @"heartbeatAt", @"coveredKinds", @"droppedEvents", @"gapDetected", @"reason", @"lastEventAt"]];
  for (NSString *field in @[@"acceptedFence", @"highWaterFence", @"observer"]) {
    NSDictionary *value = status[field];
    if (value == nil && [field isEqual:@"highWaterFence"]) continue;
    if (![value isKindOfClass:NSDictionary.class]) return NO;
    NSSet *allowed = [field isEqual:@"observer"] ? observerKeys : fenceKeys;
    for (id key in value) if (![allowed containsObject:key]) return NO;
    for (id nested in value.allValues) if ([nested isKindOfClass:NSDictionary.class]) return NO;
  }
  NSString *operationId = status[@"operationId"];
  NSDictionary *previous = _statuses[operationId];
  if (previous == nil && _statuses.count >= 10000) return NO;
  if (previous != nil) {
    for (NSString *key in @[@"runtimeEpoch", @"loginSessionId", @"nativeGeneration", @"acceptedFence"]) if (![previous[key] isEqual:status[key]]) return NO;
    NSSet *terminal = [NSSet setWithArray:@[@"finished", @"cancelled", @"failed"]];
    if ([terminal containsObject:previous[@"execution"]] && ![terminal containsObject:status[@"execution"]]) return NO;
    for (NSString *key in @[@"ledgerRevision", @"dispatchAttempts"]) {
      if ([previous[key] unsignedLongLongValue] > [status[key] unsignedLongLongValue]) return NO;
    }
  }
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:status options:0 error:NULL];
  if (encoded == nil || encoded.length > 16384) return NO;
  NSUInteger oldSize = [_sizes[operationId] unsignedIntegerValue];
  if (_bytes - oldSize + encoded.length > 32 * 1024 * 1024) return NO;
  NSDictionary *copy = [NSJSONSerialization JSONObjectWithData:encoded options:0 error:NULL];
  if (copy == nil) return NO;
  _statuses[operationId] = copy;
  _sizes[operationId] = @(encoded.length);
  _bytes = _bytes - oldSize + encoded.length;
  return YES;
}
- (NSDictionary *)statusForOperation:(NSString *)operationId requestId:(NSString *)requestId {
  if (![operationId isKindOfClass:NSString.class] || ![requestId isKindOfClass:NSString.class]) return nil;
  NSMutableDictionary *status = [_statuses[operationId] mutableCopy];
  if (status == nil) return nil;
  status[@"requestId"] = requestId;
  return [status copy];
}
@end
