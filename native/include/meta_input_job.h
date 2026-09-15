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
- (void)requestCancel;
- (BOOL)deliverLedgerAck:(NSDictionary *)ack;
- (BOOL)persistLedger:(const MetaLedgerPersistenceRequest *)request ack:(MetaLedgerPersistenceAck *)ack;
- (void)publishStatus:(MetaExecutorStatus)status;
- (NSDictionary *)statusForRequest:(NSString *)requestId;
@end
#endif
