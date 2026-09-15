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
// Header и raw bytes занимают один элемент очереди и не перемежаются с JSON.
// Bytes копируются до возврата; borrowed capture result затем можно освободить.
- (BOOL)enqueueBinaryFrame:(NSDictionary *)frame bytes:(NSData *)bytes;
- (void)close;
@end

#endif
