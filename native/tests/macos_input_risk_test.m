#include "meta_macos_input.h"
#include <assert.h>
#include <stdio.h>

typedef struct {
  size_t calls;
  MetaInputPrimitiveRisk risk;
  uint32_t code;
} Fixture;

static bool reject(void *context, MetaInputPrimitiveRisk risk, uint32_t code) {
  Fixture *fixture = context;
  fixture->calls += 1;
  fixture->risk = risk;
  fixture->code = code;
  return false;
}

int main(void) {
  Fixture fixture = {0};
  MetaMacOSInput *input = meta_macos_input_create();
  assert(input != NULL);
  assert(meta_macos_input_set_risk_validator(input, &fixture, reject));
  assert(!meta_macos_input_set_risk_validator(input, &fixture, reject));
  assert(!meta_macos_input_post_held(input, META_EVENT_KEY, 55, true, 1));
  assert(fixture.calls == 1 && fixture.risk == META_INPUT_RISK_KEY && fixture.code == 55);
  assert(!meta_macos_input_post_held(input, META_EVENT_BUTTON, 1, true, 1));
  assert(fixture.calls == 2 && fixture.risk == META_INPUT_RISK_BUTTON && fixture.code == 1);
  uint16_t text[] = {65};
  assert(!meta_macos_input_post_text(input, text, 1, 1));
  assert(fixture.calls == 3 && fixture.risk == META_INPUT_RISK_KEY && fixture.code == 0);
  MetaPointerEvent move = {.kind = META_POINTER_MOVE, .button = META_POINTER_LEFT, .x = 1, .y = 1};
  assert(!meta_macos_input_post_pointer(input, &move, 1));
  assert(fixture.calls == 4 && fixture.risk == META_INPUT_RISK_NO_HELD_INPUT);
  move.kind = META_POINTER_DRAG;
  move.button = META_POINTER_MIDDLE;
  assert(!meta_macos_input_post_pointer(input, &move, 1));
  assert(fixture.calls == 5 && fixture.risk == META_INPUT_RISK_BUTTON && fixture.code == 2);
  MetaScrollEvent scroll = {.unit = META_SCROLL_PIXEL, .dx = 1};
  assert(!meta_macos_input_post_scroll(input, &scroll, 1));
  assert(fixture.calls == 6 && fixture.risk == META_INPUT_RISK_NO_HELD_INPUT);
  meta_macos_input_destroy(input);
  puts("input risk rejection tests passed; no SDK events created or posted");
  return 0;
}
