#ifndef META_READINESS_SYSTEM_H
#define META_READINESS_SYSTEM_H

#import <Foundation/Foundation.h>
#include "meta_macos.h"
#include "meta_readiness_command.h"
#include "../observer-command/meta_observer_command.h"

// Короткоживущий action-worker context. Не отправляет события и не владеет
// executor: только свежие native факты и nondestructive observer history.
@interface MetaReadinessSystemContext : NSObject
- (instancetype)initWithWindows:(MetaMacOSBackend *)windows
                 expectedDisplay:(NSDictionary *)expectedDisplay
                         observer:(MetaObserverCommandBinder *)observer
                 observerInstance:(NSString *)observerInstance
                  sessionProvider:(NSDictionary *(^)(void))sessionProvider;
- (MetaInputReadinessBackend)backend;
- (BOOL)targetAvailable;
- (NSDictionary *)coverage;
@end

#endif
