#ifndef META_WINDOW_READBACK_H
#define META_WINDOW_READBACK_H
#include "meta_macos.h"

// Boolean activation API не является доказательством; успех подтверждает
// только фактическое frontmost + exact AX focused состояние.
bool meta_window_focus_state_confirmed(bool frontmost,
                                       MetaTriState focused);

// Вызывается после свежего inventory; process_matches проверяется владельцем
// через live process start, а не через только что переданный снимок.
void meta_window_classify_close(const MetaInventorySnapshot *snapshot,
                                 const MetaWindowRecord *original,
                                 uint64_t launch_time_micros,
                                 bool process_matches,
                                 bool close_dispatched,
                                 MetaWindowTransition *result);

// Подтверждает существование exact target в свежем domain-local snapshot.
// target_matches является отдельным live borrow/PID birth proof владельца.
void meta_window_classify_existing(const MetaInventorySnapshot *snapshot,
                                    const MetaWindowRecord *original,
                                    bool target_matches,
                                    MetaWindowTransition *result);
#endif
