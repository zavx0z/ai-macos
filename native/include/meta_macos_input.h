#ifndef META_MACOS_INPUT_H
#define META_MACOS_INPUT_H

#include "meta_native.h"

typedef struct MetaMacOSInput MetaMacOSInput;

typedef enum {
  META_INPUT_RISK_NO_HELD_INPUT,
  META_INPUT_RISK_KEY,
  META_INPUT_RISK_BUTTON,
} MetaInputPrimitiveRisk;
typedef bool (*MetaInputRiskValidator)(void *context,
                                       MetaInputPrimitiveRisk risk,
                                       uint32_t code);

MetaMacOSInput *meta_macos_input_create(void);
void meta_macos_input_destroy(MetaMacOSInput *input);
// Устанавливается один раз production broker. Отсутствующий descriptor должен
// отвергаться callback; cleanup UP живого executor использует отдельный путь.
bool meta_macos_input_set_risk_validator(MetaMacOSInput *input,
                                        void *context,
                                        MetaInputRiskValidator validate);
bool meta_macos_input_preflight(void);
bool meta_macos_input_set_flags(void *context, uint64_t flags);
bool meta_macos_input_post_held(void *context, MetaHeldEventKind kind,
                                uint32_t code, bool down,
                                uint64_t synthetic_tag);
bool meta_macos_input_post_cleanup_up(void *context, MetaHeldEventKind kind,
                                      uint32_t code,
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
