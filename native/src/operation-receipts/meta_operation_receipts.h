#ifndef META_OPERATION_RECEIPTS_H
#define META_OPERATION_RECEIPTS_H
#import <Foundation/Foundation.h>

// Только control queue. Хранятся immutable status metadata без action payload.
// Переполнение требует rotation: старые receipts не вытесняются молча.
@interface MetaOperationReceipts : NSObject
- (BOOL)recordStatus:(NSDictionary *)status;
- (NSDictionary *)statusForOperation:(NSString *)operationId requestId:(NSString *)requestId;
@end
#endif
