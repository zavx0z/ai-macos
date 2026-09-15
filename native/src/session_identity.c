#include "meta_session_identity.h"
#include <bsm/audit.h>
#include <errno.h>
#include <unistd.h>

static uint32_t real_uid(void *context) { (void)context; return getuid(); }
static uint32_t effective_uid(void *context) { (void)context; return geteuid(); }
static int audit_identity(void *context, uint32_t *uid, uint32_t *session) {
  (void)context;
  auditinfo_addr_t info = {0};
  if (getaudit_addr(&info, sizeof(info)) != 0) return errno;
  *uid = info.ai_auid;
  *session = info.ai_asid;
  return 0;
}

MetaSessionIdentity meta_session_identity_read_with_backend(MetaSessionIdentityBackend backend) {
  MetaSessionIdentity result = {0};
  if (backend.uid == NULL || backend.effective_uid == NULL || backend.audit == NULL) {
    result.error_number = EINVAL;
    return result;
  }
  result.uid = backend.uid(backend.context);
  result.effective_uid = backend.effective_uid(backend.context);
  result.error_number = backend.audit(backend.context, &result.audit_user_id, &result.audit_session_id);
  if (result.error_number != 0) return result;
  if (result.audit_session_id == 0 || result.audit_session_id == UINT32_MAX || result.audit_user_id == UINT32_MAX) {
    result.error_number = ENODATA;
    return result;
  }
  result.verified = true;
  return result;
}

MetaSessionIdentity meta_session_identity_read(void) {
  return meta_session_identity_read_with_backend((MetaSessionIdentityBackend){
    .uid = real_uid, .effective_uid = effective_uid, .audit = audit_identity,
  });
}
