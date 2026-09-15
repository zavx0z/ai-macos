#ifndef META_WINDOW_ACTIONS_H
#define META_WINDOW_ACTIONS_H

#include "meta_macos.h"

typedef enum {
  META_WINDOW_ACTION_SHOW,
  META_WINDOW_ACTION_FOCUS,
  META_WINDOW_ACTION_SET_BOUNDS,
  META_WINDOW_ACTION_SET_MINIMIZED,
  META_WINDOW_ACTION_CLOSE,
} MetaWindowActionKind;

typedef struct {
  MetaWindowActionKind kind;
  const char *window_ref;
  union {
    MetaRect bounds;
    bool minimized;
  } value;
} MetaWindowActionRequest;

typedef bool (*MetaWindowShowFunction)(void *context, const char *window_ref,
                                       MetaWindowTransition *result);
typedef bool (*MetaWindowFocusFunction)(void *context, const char *window_ref,
                                        MetaWindowTransition *result);
typedef bool (*MetaWindowSetBoundsFunction)(void *context,
                                            const char *window_ref,
                                            MetaRect requested_frame,
                                            MetaWindowTransition *result);
typedef bool (*MetaWindowSetMinimizedFunction)(void *context,
                                               const char *window_ref,
                                               bool minimized,
                                               MetaWindowTransition *result);
typedef bool (*MetaWindowCloseFunction)(void *context, const char *window_ref,
                                        MetaWindowTransition *result);

typedef struct {
  void *context;
  MetaWindowShowFunction show_window;
  MetaWindowFocusFunction focus_window;
  MetaWindowSetBoundsFunction set_window_bounds;
  MetaWindowSetMinimizedFunction set_window_minimized;
  MetaWindowCloseFunction close_window;
} MetaWindowActionBackend;

typedef enum {
  META_WINDOW_ACTION_DISPATCHED,
  META_WINDOW_ACTION_INVALID_REQUEST,
  META_WINDOW_ACTION_BACKEND_UNAVAILABLE,
  META_WINDOW_ACTION_BACKEND_CONTRACT_VIOLATION,
} MetaWindowActionDispatchStatus;

// Dispatcher вызывается на уже авторизованном action worker. Fence, lease,
// deadline и измерения dispatch остаются у владельца command loop.
MetaWindowActionDispatchStatus meta_window_action_dispatch(
    const MetaWindowActionBackend *backend,
    const MetaWindowActionRequest *request,
    MetaWindowTransition *result);

// Адаптер лишь связывает injected table с существующим macOS backend и не
// создаёт второй registry, scheduler или lifecycle.
MetaWindowActionBackend meta_window_action_backend_macos(
    MetaMacOSBackend *backend);

#endif
