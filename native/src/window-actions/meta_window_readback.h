#ifndef META_WINDOW_READBACK_H
#define META_WINDOW_READBACK_H
#include "meta_macos.h"

// Вызывается после свежего inventory; process_matches проверяется владельцем
// через live process start, а не через только что переданный снимок.
void meta_window_classify_close(const MetaInventorySnapshot *snapshot,
                                 const MetaWindowRecord *original,
                                 uint64_t launch_time_micros,
                                 bool process_matches,
                                 bool close_dispatched,
                                 MetaWindowTransition *result);
#endif
