#ifndef META_INPUT_EXECUTOR_H
#define META_INPUT_EXECUTOR_H
#include "meta_input_job.h"

@interface MetaInputExecutor : NSObject
- (instancetype)initWithGeneration:(NSString *)generation
                              sink:(MetaExecutorBackend)sink
                            verify:(BOOL (^)(NSString *target))verify;
- (NSDictionary *)execute:(NSDictionary *)request job:(MetaInputJob *)job;
// Общий native mutation gate использует тот же executor/fence, что и input.
// verify проверяет точный target либо подтверждённое postcondition после action.
- (NSDictionary *)executeExternal:(NSDictionary *)request
                               job:(MetaInputJob *)job
                         targetRef:(NSString *)targetRef
                            verify:(BOOL (^)(NSString *target))verify
                            action:(NSDictionary *(^)(void))action;
- (MetaExecutor *)executorOnActionWorker;
- (BOOL)sealForRotation;
@end
#endif
