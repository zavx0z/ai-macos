#ifndef META_MACOS_INPUT_H
#define META_MACOS_INPUT_H

#include "meta_native.h"

typedef struct MetaMacOSInput MetaMacOSInput;

MetaMacOSInput *meta_macos_input_create(void);
void meta_macos_input_destroy(MetaMacOSInput *input);
bool meta_macos_input_preflight(void);
bool meta_macos_input_set_flags(void *context, uint64_t flags);
bool meta_macos_input_post_held(void *context, MetaHeldEventKind kind,
                                uint32_t code, bool down,
                                uint64_t synthetic_tag);
bool meta_macos_input_post_text(void *context, const uint16_t *utf16_units,
                                size_t utf16_count,
                                uint64_t synthetic_tag);
bool meta_macos_input_post_pointer(void *context,
                                   const MetaPointerEvent *event,
                                   uint64_t synthetic_tag);
bool meta_macos_input_post_scroll(void *context,
                                  const MetaScrollEvent *event,
                                  uint64_t synthetic_tag);

#endif
