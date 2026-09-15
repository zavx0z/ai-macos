#ifndef META_AX_REQUEST_H
#define META_AX_REQUEST_H
#include "meta_macos.h"
#include "../src/accessibility/meta_ax_inspector.h"

// request, snapshotId и borrow должны жить до завершения synchronous inspection.
bool meta_ax_build_request(const MetaAXTargetBorrow *borrow, NSDictionary *request,
                           NSString *snapshotId, MetaAXInspectionContext *output);
#endif
