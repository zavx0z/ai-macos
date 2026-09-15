#ifndef META_COMMAND_LOOP_H
#define META_COMMAND_LOOP_H

#import <Foundation/Foundation.h>
#include "meta_input_job.h"

@protocol MetaCommandBackend <NSObject>
- (NSDictionary *)sessionIdentity;
- (NSDictionary *)permissions;
- (NSDictionary *)inventory;
- (NSDictionary *)inspect:(NSDictionary *)request;
- (NSDictionary *)clipboard:(NSDictionary *)command;
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId;
- (NSDictionary *)cancel:(NSDictionary *)request;
- (NSDictionary *)executeInput:(NSDictionary *)request job:(MetaInputJob *)job;
- (NSDictionary *)executeWindow:(NSDictionary *)request job:(MetaInputJob *)job;
- (BOOL)beginRotation;
@end

int meta_command_loop_run(id<MetaCommandBackend> backend,
                          NSString *buildId,
                          NSString *installRoot,
                          NSString *nativeGeneration,
                          int inputDescriptor,
                          int outputDescriptor);

#endif
