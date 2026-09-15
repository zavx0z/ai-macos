#ifndef META_BROKER_TRANSPORT_H
#define META_BROKER_TRANSPORT_H

#import <Foundation/Foundation.h>

typedef void (^MetaTransportMessage)(NSDictionary *message);
typedef void (^MetaTransportFailure)(NSString *reason);

@interface MetaBrokerTransport : NSObject
- (instancetype)initWithInput:(int)input
                        output:(int)output
                 callbackQueue:(dispatch_queue_t)callbackQueue
                     onMessage:(MetaTransportMessage)onMessage
                     onFailure:(MetaTransportFailure)onFailure;
- (void)start;
- (BOOL)enqueueFrame:(NSDictionary *)frame;
- (void)close;
@end

#endif
