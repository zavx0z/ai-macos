#ifndef META_DOMAIN_RECOVERY_H
#define META_DOMAIN_RECOVERY_H

#import <Foundation/Foundation.h>

#include "../recovery-probe/meta_recovery_probe.h"

NS_ASSUME_NONNULL_BEGIN

// Проверяет persisted grant/optional ledger и пассивно читает весь descriptor
// risk set. Не создаёт ledger, не вызывает executor и не отправляет UP.
NSDictionary *_Nullable meta_domain_recovery_receive(
    NSDictionary *owner,
    NSDictionary *request,
    MetaRecoveryProbeBackend backend);

NS_ASSUME_NONNULL_END

#endif
