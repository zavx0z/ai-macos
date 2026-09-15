#import <Foundation/Foundation.h>

#include <assert.h>
#include <stdio.h>

#include "meta_macos.h"

typedef struct {
  MetaDisplayTopologyChanged changed;
  void *callback_context;
  bool start_succeeds;
  bool invoke_during_stop;
  bool stop_succeeds;
  size_t start_calls;
  size_t stop_calls;
} FakeObserver;

static bool start_observer(void *context, MetaDisplayTopologyChanged changed,
                           void *callback_context) {
  FakeObserver *observer = context;
  observer->start_calls += 1;
  if (!observer->start_succeeds) return false;
  observer->changed = changed;
  observer->callback_context = callback_context;
  return true;
}

static bool stop_observer(void *context, MetaDisplayTopologyChanged changed,
                          void *callback_context) {
  FakeObserver *observer = context;
  observer->stop_calls += 1;
  assert(observer->changed == changed);
  assert(observer->callback_context == callback_context);
  if (observer->invoke_during_stop) {
    changed(1, kCGDisplaySetModeFlag, callback_context);
  }
  if (!observer->stop_succeeds) return false;
  observer->changed = NULL;
  observer->callback_context = NULL;
  return true;
}

static MetaDisplayTopologyObserverBackend backend(FakeObserver *observer) {
  return (MetaDisplayTopologyObserverBackend){
      .context = observer,
      .start = start_observer,
      .stop = stop_observer,
  };
}

static void test_epoch_is_monotonic_and_stop_is_safe(void) {
  FakeObserver observer = {
      .start_succeeds = true,
      .invoke_during_stop = true,
      .stop_succeeds = true,
  };
  MetaMacOSBackend *windows =
      meta_macos_backend_create_with_topology_observer("native-1",
                                                       backend(&observer));
  assert(windows != NULL);
  uint64_t epoch = 0;
  assert(meta_macos_display_topology_epoch(windows, &epoch));
  assert(epoch == 1);
  observer.changed(10, kCGDisplayAddFlag, observer.callback_context);
  assert(meta_macos_display_topology_epoch(windows, &epoch));
  assert(epoch == 2);
  observer.changed(10, kCGDisplayRemoveFlag, observer.callback_context);
  assert(meta_macos_display_topology_epoch(windows, &epoch));
  assert(epoch == 3);
  assert(meta_macos_backend_destroy(windows));
  assert(observer.start_calls == 1);
  assert(observer.stop_calls == 1);
  assert(observer.changed == NULL);
}

static void test_failed_remove_retains_callback_context_until_retry(void) {
  FakeObserver observer = {
      .start_succeeds = true,
      .stop_succeeds = false,
  };
  MetaMacOSBackend *windows =
      meta_macos_backend_create_with_topology_observer("native-1",
                                                       backend(&observer));
  assert(windows != NULL);
  assert(!meta_macos_backend_destroy(windows));
  assert(observer.stop_calls == 1);
  assert(observer.changed != NULL);
  observer.changed(2, kCGDisplayAddFlag, observer.callback_context);
  uint64_t epoch = 0;
  assert(!meta_macos_display_topology_epoch(windows, &epoch));
  observer.stop_succeeds = true;
  assert(meta_macos_backend_destroy(windows));
  assert(observer.stop_calls == 2);
  assert(observer.changed == NULL);
}

static void test_registration_failure_has_no_positive_backend(void) {
  FakeObserver observer = {0};
  MetaMacOSBackend *windows =
      meta_macos_backend_create_with_topology_observer("native-1",
                                                       backend(&observer));
  assert(windows == NULL);
  assert(observer.start_calls == 1);
  assert(observer.stop_calls == 0);
}

int main(void) {
  @autoreleasepool {
    test_epoch_is_monotonic_and_stop_is_safe();
    test_failed_remove_retains_callback_context_until_retry();
    test_registration_failure_has_no_positive_backend();
    puts("macOS backend topology tests passed");
  }
  return 0;
}
