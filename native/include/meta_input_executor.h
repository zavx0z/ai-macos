#ifndef META_INPUT_EXECUTOR_H
#define META_INPUT_EXECUTOR_H
#include "meta_input_job.h"

typedef NS_ENUM(NSInteger, MetaInputObserverDecision) {
  MetaInputObserverContinue,
  MetaInputObserverForeignEvent,
  MetaInputObserverUnavailable,
};

@interface MetaInputExecutor : NSObject
- (instancetype)initWithGeneration:(NSString *)generation
                              sink:(MetaExecutorBackend)sink
                            verify:(BOOL (^)(NSString *target))verify;
- (NSDictionary *)execute:(NSDictionary *)request job:(MetaInputJob *)job;
- (void)setPointVerifier:(BOOL (^)(NSString *target, double x, double y))verify;
- (void)setScopedPointVerifier:(BOOL (^)(NSDictionary *target, double x, double y))verify;
// Только normal input: register вызывается после begin до первого post,
// poll — на том же action worker между primitives, без потребления PUSH.
// Caller снимает exact tag после возврата execute и не меняет executor с callbacks.
- (void)setInputObserverAfterBegin:(BOOL (^)(MetaExecutor *executor, MetaInputJob *job))afterBegin
                              poll:(MetaInputObserverDecision (^)(void))poll;
// Общий native mutation gate использует тот же executor/fence, что и input.
// verify проверяет точный target либо подтверждённое postcondition после action.
- (NSDictionary *)executeExternal:(NSDictionary *)request
                               job:(MetaInputJob *)job
                         targetRef:(NSString *)targetRef
                            verify:(BOOL (^)(NSString *target))verify
                            action:(NSDictionary *(^)(void))action;
- (MetaExecutor *)executorOnActionWorker;
// Callback использует только уже fenced C primitives; внешний dispatch не считается.
- (NSDictionary *)executePrimitive:(NSDictionary *)request
                                job:(MetaInputJob *)job
                          targetRef:(NSString *)targetRef
                             verify:(BOOL (^)(NSString *target))verify
                             action:(NSDictionary *(^)(void))action;
- (BOOL)sealForRotation;
@end
#endif
