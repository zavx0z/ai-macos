#include "meta_session_identity.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>

typedef struct { int error; uint32_t session; } Fixture;
static uint32_t uid(void *context) { (void)context; return 501; }
static uint32_t effective_uid(void *context) { (void)context; return 502; }
static int audit(void *context, uint32_t *user, uint32_t *session) {
  Fixture *fixture = context;
  *user = 501;
  *session = fixture->session;
  return fixture->error;
}
int main(void) {
  Fixture fixture = {.session = 42};
  MetaSessionIdentityBackend backend = {.context = &fixture, .uid = uid, .effective_uid = effective_uid, .audit = audit};
  MetaSessionIdentity result = meta_session_identity_read_with_backend(backend);
  assert(result.verified && result.uid == 501 && result.effective_uid == 502 && result.audit_session_id == 42);
  fixture.error = EPERM;
  result = meta_session_identity_read_with_backend(backend);
  assert(!result.verified && result.error_number == EPERM);
  fixture.error = 0;
  fixture.session = 0;
  result = meta_session_identity_read_with_backend(backend);
  assert(!result.verified && result.error_number == ENODATA);
  puts("session identity tests passed");
  return 0;
}
