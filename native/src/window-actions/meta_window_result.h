#ifndef META_WINDOW_RESULT_H
#define META_WINDOW_RESULT_H

#import <Foundation/Foundation.h>

#include "meta_macos.h"

// Формирует только raw NativeWindowTransitionResult из уже свежего snapshot.
// Проверка operation/fence/deadline остаётся у единственного command owner.
NSDictionary *meta_window_transition_value(
    const MetaInventorySnapshot *snapshot,
    const MetaWindowRecord *original,
    const MetaWindowTransition *transition,
    NSDictionary *status,
    NSString *sourceResponseRef);

#endif
