#ifndef META_COMMAND_LOOP_H
#define META_COMMAND_LOOP_H

#import <Foundation/Foundation.h>

@protocol MetaCommandBackend <NSObject>
- (NSDictionary *)permissions;
- (NSDictionary *)inventory;
- (NSDictionary *)clipboard:(NSDictionary *)command;
- (NSDictionary *)status:(NSString *)operationId requestId:(NSString *)requestId;
- (NSDictionary *)cancel:(NSDictionary *)request;
- (BOOL)beginRotation;
@end

int meta_command_loop_run(id<MetaCommandBackend> backend,
                          NSString *buildId,
                          NSString *installRoot,
                          NSString *nativeGeneration,
                          int inputDescriptor,
                          int outputDescriptor);

#endif
