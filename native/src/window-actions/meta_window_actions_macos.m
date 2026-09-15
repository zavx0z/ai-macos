#include "meta_window_actions.h"

static bool show_window(void *context, const char *window_ref,
                        MetaWindowTransition *result) {
  return meta_macos_show_window((MetaMacOSBackend *)context, window_ref, result);
}

static bool focus_window(void *context, const char *window_ref,
                         MetaWindowTransition *result) {
  return meta_macos_focus_window((MetaMacOSBackend *)context, window_ref,
                                 result);
}

static bool set_window_bounds(void *context, const char *window_ref,
                              MetaRect requested_frame,
                              MetaWindowTransition *result) {
  return meta_macos_set_window_bounds((MetaMacOSBackend *)context, window_ref,
                                      requested_frame, result);
}

static bool set_window_minimized(void *context, const char *window_ref,
                                 bool minimized,
                                 MetaWindowTransition *result) {
  return meta_macos_set_window_minimized((MetaMacOSBackend *)context,
                                         window_ref, minimized, result);
}

static bool close_window(void *context, const char *window_ref,
                         MetaWindowTransition *result) {
  return meta_macos_close_window((MetaMacOSBackend *)context, window_ref,
                                 result);
}

MetaWindowActionBackend meta_window_action_backend_macos(
    MetaMacOSBackend *backend) {
  if (backend == NULL) return (MetaWindowActionBackend){0};
  return (MetaWindowActionBackend){
      .context = backend,
      .show_window = show_window,
      .focus_window = focus_window,
      .set_window_bounds = set_window_bounds,
      .set_window_minimized = set_window_minimized,
      .close_window = close_window,
  };
}
