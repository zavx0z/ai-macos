#ifndef META_SESSION_STATE_H
#define META_SESSION_STATE_H

#import <Foundation/Foundation.h>

#include "meta_session_identity.h"

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  void *_Nullable context;
  NSDictionary *_Nullable (*_Nullable current_dictionary)(
      void *_Nullable context);
  MetaSessionIdentity (*audit_identity)(void *_Nullable context);
  bool (*_Nullable secure_input)(void *_Nullable context, bool *enabled);
  NSDate *_Nullable (*_Nonnull now)(void *_Nullable context);
} MetaSessionStateBackend;

// Возвращает passive readiness текущего процесса относительно уже принятого
// audit loginSessionId. Lock state без внешнего отрицательного сигнала неизвестен.
NSDictionary *_Nullable meta_current_session_readiness(
    NSString *expected_admitted_login_session_id);

NSDictionary *_Nullable meta_current_session_readiness_with_backend(
    NSString *expected_admitted_login_session_id,
    MetaSessionStateBackend backend);

NS_ASSUME_NONNULL_END

#endif
