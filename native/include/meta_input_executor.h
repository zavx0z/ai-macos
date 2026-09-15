#ifndef META_INPUT_EXECUTOR_H
#define META_INPUT_EXECUTOR_H
#include "meta_input_job.h"

@interface MetaInputExecutor : NSObject
- (instancetype)initWithGeneration:(NSString *)generation
                              sink:(MetaExecutorBackend)sink
                            verify:(BOOL (^)(NSString *target))verify;
- (NSDictionary *)execute:(NSDictionary *)request job:(MetaInputJob *)job;
- (BOOL)sealForRotation;
@end
#endif
