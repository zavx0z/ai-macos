#ifndef META_COMMAND_LOOP_H
#define META_COMMAND_LOOP_H

#import <Foundation/Foundation.h>
#include "meta_input_job.h"

@protocol MetaCommandBackend <NSObject>
- (NSDictionary *)sessionIdentity;
- (NSDictionary *)permissions;
- (NSDictionary *)inventory;
- (NSDictionary *)inspect:(NSDictionary *)request;
- (NSDictionary *)resolveApplication:(NSDictionary *)request;
- (NSDictionary *)hitTest:(NSDictionary *)request;
- (NSDictionary *)startCapture:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSDictionary *)cleanupCapture:(NSDictionary *)request emitBinary:(BOOL (^)(NSDictionary *header, NSData *bytes))emitBinary;
- (NSDictionary *)supplementStatus:(NSDictionary *)status;
- (NSDictionary *)reconcileStatus:(NSDictionary *)status;
- (NSArray<NSString *> *)pendingOperationIds;
- (NSDictionary *)clipboard:(NSDictionary *)command;
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId;
- (NSDictionary *)cancel:(NSDictionary *)request;
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSDictionary *)executeApplication:(NSDictionary *)request job:(MetaInputJob *)job;
- (BOOL)beginRotation;
@optional
- (NSString *)recoveryDomainVersion;
- (BOOL)validateRecoveryRequest:(NSDictionary *)request;
- (NSDictionary *)cursorDisplay:(NSDictionary *)request;
- (NSDictionary *)executeAxPress:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSArray<NSDictionary *> *)capabilityCatalog;
- (NSDictionary *)executeReadiness:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSDictionary *)heldRecovery:(NSDictionary *)request owner:(NSDictionary *)owner;
- (NSDictionary *)observer:(NSDictionary *)request;
- (BOOL)activateObserverPush:(NSString *)instanceRef;
- (NSDictionary *)takeObserverPush:(NSUInteger)maximum;
- (void)stopObserver;
@end

int meta_command_loop_run(id<MetaCommandBackend> backend,
                          NSString *buildId,
                          NSString *installRoot,
                          NSString *nativeGeneration,
                          int inputDescriptor,
                          int outputDescriptor);

#endif
