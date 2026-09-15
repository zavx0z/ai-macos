#ifndef META_RECOVERY_PROBE_H
#define META_RECOVERY_PROBE_H

#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MetaRecoverySessionState) {
  MetaRecoverySessionStateUnknown,
  MetaRecoverySessionStateActiveConsole,
  MetaRecoverySessionStateInactive,
};

typedef NS_ENUM(NSInteger, MetaRecoveryLockState) {
  MetaRecoveryLockStateUnknown,
  MetaRecoveryLockStateLocked,
};

typedef NS_ENUM(NSInteger, MetaRecoverySecureInputState) {
  MetaRecoverySecureInputStateUnknown,
  MetaRecoverySecureInputStateOff,
  MetaRecoverySecureInputStateOn,
};

typedef NS_ENUM(NSInteger, MetaRecoveryObservedState) {
  MetaRecoveryObservedStateUnknown,
  MetaRecoveryObservedStateUp,
  MetaRecoveryObservedStateHeld,
};

typedef struct {
  bool input_monitoring;
  MetaRecoverySessionState session_state;
  MetaRecoveryLockState lock_state;
  MetaRecoverySecureInputState secure_input;
  bool observer_ready;
} MetaRecoveryReadiness;

typedef struct {
  void *context;
  NSDate *(*now)(void *context);
  bool (*readiness)(void *context, MetaRecoveryReadiness *readiness);
  MetaRecoveryObservedState (*sample_key)(void *context, uint32_t code);
  MetaRecoveryObservedState (*sample_button)(void *context, uint32_t code);
} MetaRecoveryProbeBackend;

// owner задаётся trusted command owner и содержит current protocol/runtime/
// login/native identity и loaded nativeBuildId. Request не определяет readiness.
NSDictionary *meta_recovery_probe_receive(NSDictionary *owner,
                                           NSDictionary *request,
                                           MetaRecoveryProbeBackend backend);

// Системный backend предоставляет clock и passive CG samplers. Readiness в нём
// намеренно отсутствует и должна прийти от владельца observer/session state.
MetaRecoveryProbeBackend meta_recovery_probe_system_backend(void);

#endif
