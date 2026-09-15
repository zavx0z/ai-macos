#ifndef META_READINESS_COMMAND_H
#define META_READINESS_COMMAND_H

#import <Foundation/Foundation.h>
#include "../readiness/meta_input_readiness.h"

NS_ASSUME_NONNULL_BEGIN

// Результат probe и состояние parent executor намеренно разделены: finished
// dispatch probe ещё не означает завершение принятой native operation.
@interface MetaReadinessCommandOutcome : NSObject
@property(nonatomic, readonly) NSDictionary *result;
@property(nonatomic, readonly) MetaExecutorStatus executorStatus;
@property(nonatomic, readonly) BOOL probeCompleted;
@end

@interface MetaReadinessCommandBinder : NSObject
// Backend предоставляет только пассивные факты и bounded observer scan.
// Pointer events отправляет исключительно переданный parent MetaExecutor.
// Время внедряется для проверки deadline без обращения к desktop API.
- (nullable instancetype)initWithGeneration:(NSDictionary *)generation
                                    backend:(MetaInputReadinessBackend)backend
                                        now:(NSDate *(^)(void))now;

// Вызывать синхронно на action worker после принятия job тем же executor.
// currentOperation/currentRequestId берутся из доверенного текущего job,
// а не повторно из request. Binder не выполняет begin/finish/cancel и не
// создаёт fence. nil означает отказ до probe; error описывает нарушенную связь.
// Владельцу command loop принадлежат завершение job и публикация final status.
- (nullable MetaReadinessCommandOutcome *)handleRequest:(NSDictionary *)request
                                      currentRequestId:(NSString *)currentRequestId
                                      currentOperation:(NSDictionary *)currentOperation
                                              executor:(MetaExecutor *)executor
                                                 error:(NSError *_Nullable *_Nullable)error;
@end

NS_ASSUME_NONNULL_END
#endif
