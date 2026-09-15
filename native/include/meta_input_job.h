#ifndef META_INPUT_JOB_H
#define META_INPUT_JOB_H
#import <Foundation/Foundation.h>
#include "meta_native.h"

typedef BOOL (^MetaInputJobEmitter)(NSDictionary *frame);

@interface MetaInputJob : NSObject
@property(nonatomic, readonly) NSDictionary *operation;
@property(nonatomic, readonly) NSString *requestId;
- (instancetype)initWithRequest:(NSDictionary *)request emitter:(MetaInputJobEmitter)emitter;
- (BOOL)cancelRequested;
- (BOOL)noteHeartbeat;
- (BOOL)heartbeatExpired;
- (void)requestCancel;
- (void)channelDisconnected;
- (BOOL)deliverLedgerAck:(NSDictionary *)ack;
- (BOOL)persistLedger:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack;
- (void)publishStatus:(MetaExecutorStatus)status;
// Provider читает текущую coverage без потребления PUSH/history. Он вызывается
// на action worker вне condition lock; nil оставляет честный unavailable status.
- (void)setObserverCoverageProvider:(NSDictionary *(^)(void))provider;
- (NSDictionary *)statusForRequest:(NSString *)requestId;
@end
#endif
