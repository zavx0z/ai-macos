#ifndef META_SESSION_IDENTITY_H
#define META_SESSION_IDENTITY_H
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint32_t uid;
  uint32_t effective_uid;
  uint32_t audit_user_id;
  uint32_t audit_session_id;
  bool verified;
  int error_number;
} MetaSessionIdentity;

typedef struct {
  void *context;
  uint32_t (*uid)(void *context);
  uint32_t (*effective_uid)(void *context);
  int (*audit)(void *context, uint32_t *audit_uid, uint32_t *audit_session_id);
} MetaSessionIdentityBackend;

MetaSessionIdentity meta_session_identity_read(void);
MetaSessionIdentity meta_session_identity_read_with_backend(MetaSessionIdentityBackend backend);
#endif
