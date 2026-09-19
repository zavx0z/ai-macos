#import <Foundation/Foundation.h>

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "meta_serialization.h"

int main(void) {
  MetaRegistry *registry = meta_registry_create("native-1");
  assert(registry != NULL);
  MetaApplicationInput application = {
      .pid = 42,
      .launch_time_micros = 1000000,
      .name = "Fixture",
      .bundle_id = "dev.meta.fixture",
      .hidden = META_FALSE,
      .ax_status = META_AX_READY,
  };
  MetaAXWindowInput ax_windows[] = {
      {.pid = 42,
       .launch_time_micros = 1000000,
       .ax_token = 1,
       .title = "Window",
       .role = "AXWindow",
       .frame = {.x = 0, .y = 0, .width = 500, .height = 400},
       .surface_kind = META_SURFACE_WINDOW,
       .can_raise = true},
      {.pid = 42,
       .launch_time_micros = 1000000,
       .ax_token = 2,
       .owner_ax_token = 1,
       .title = "",
       .role = "AXSheet",
       .frame = {.x = 0, .y = 0, .width = 500, .height = 400},
       .surface_kind = META_SURFACE_SHEET,
       .can_close = true},
  };
  MetaCGWindowInput cg_windows[] = {
      {.window_id = 10,
       .pid = 42,
       .title = "Window",
       .frame = {.x = 0, .y = 0, .width = 500, .height = 400},
       .on_screen = META_TRUE},
      {.window_id = 11,
       .pid = 42,
       .title = "Unresolved",
       .frame = {.x = 600, .y = 0, .width = 200, .height = 100},
       .on_screen = META_FALSE},
  };
  MetaDisplayInput display = {
      .display_id = 100,
      .bounds = {.x = -1920, .y = 0, .width = 1920, .height = 1080},
      .usable_bounds = {.x = -1920, .y = 23, .width = 1920, .height = 1057},
      .scale = 2,
      .main = true,
  };
  MetaInventoryInput input = {
      .applications = &application,
      .application_count = 1,
      .ax_windows = ax_windows,
      .ax_window_count = 2,
      .cg_windows = cg_windows,
      .cg_window_count = 2,
      .displays = &display,
      .display_count = 1,
      .source_complete = true,
      .captured_at_micros = 2000000,
  };
  assert(meta_registry_refresh(registry, &input));
  CFDataRef data = meta_inventory_copy_json(meta_registry_snapshot(registry),
                                            "response-1");
  assert(data != NULL);
  NSError *error = nil;
  NSDictionary *json = [NSJSONSerialization
      JSONObjectWithData:(__bridge NSData *)data options:0 error:&error];
  assert(error == nil);
  assert([json[@"windows"] count] == 2);
  NSDictionary *window = json[@"windows"][0];
  NSDictionary *unresolved = json[@"windows"][1];
  assert([window[@"kind"] isEqualToString:@"ax-window"]);
  assert([window[@"surfaces"] count] == 1);
  assert([window[@"surfaces"][0][@"ownerWindowRef"]
      isEqual:window[@"windowRef"]]);
  assert([window[@"surfaces"][0][@"title"] isEqual:@""]);
  assert([window[@"surfaces"][0][@"role"] isEqual:@"AXSheet"]);
  assert([unresolved[@"kind"] isEqualToString:@"cg-only"]);
  assert(unresolved[@"windowRef"] == nil);
  assert([json[@"displayLayoutRevision"] unsignedLongLongValue] == 1);
  assert([json[@"layoutRef"] isEqual:@(meta_registry_snapshot(registry)->layout_ref)]);
  CFRelease(data);
  // Synthetic UTF-8 boundaries; no live windows.
  const char *glyphs[] = {"Z", "\xD0\x96", "\xE2\x82\xAC", "\xF0\x9F\xA7\xA0"};
  unsigned cases = 0;
  for (size_t g = 0; g < 4; ++g) {
    size_t width = strlen(glyphs[g]);
    for (size_t room = 0; room <= width; ++room) {
      char title[META_NATIVE_TEXT_CAPACITY + 8];
      size_t prefix = META_NATIVE_TEXT_CAPACITY - 1 - room;
      memset(title, 65, prefix);
      memcpy(title + prefix, glyphs[g], width + 1);
      ax_windows[0].title = title;
      assert(meta_registry_refresh(registry, &input));
      @try {
        CFDataRef probe = meta_inventory_copy_json(meta_registry_snapshot(registry), "utf8-test");
        assert(probe != NULL);
        NSDictionary *value = [NSJSONSerialization JSONObjectWithData:(__bridge NSData *)probe options:0 error:NULL];
        NSString *expected = [[NSString alloc] initWithBytes:title length:prefix + (room >= width ? width : 0) encoding:NSUTF8StringEncoding];
        assert([value[@"windows"][0][@"title"] isEqualToString:expected]);
        CFRelease(probe);
      } @catch (NSException *exception) {
        fprintf(stderr, "UTF8_REGRESSION_FAILED width=%zu room=%zu %s\n", width, room, exception.reason.UTF8String);
        meta_registry_destroy(registry);
        return 1;
      }
      ++cases;
    }
  }
  printf("UTF8_REGRESSION_PASSED cases=%u\n", cases);
  for (size_t kind = 0; kind < 2; ++kind) {
    MetaInventorySnapshot bad = *meta_registry_snapshot(registry);
    MetaWindowRecord item = bad.windows[0];
    memset(item.title, kind == 0 ? 0 : 65, sizeof(item.title));
    if (kind == 0) item.title[0] = (char)0xD0;
    bad.windows = &item;
    bad.window_count = 1;
    @try {
      CFDataRef probe = meta_inventory_copy_json(&bad, "invalid-title");
      if (probe != NULL) { CFRelease(probe); return 2; }
    } @catch (NSException *exception) {
      fprintf(stderr, "INVALID_TITLE_THROW kind=%zu %s\n", kind, exception.name.UTF8String);
      meta_registry_destroy(registry);
      return 2;
    }
  }
  puts("INVALID_TITLE_REJECTION_PASSED cases=2");
  MetaCaptureDisplayRegion region = {
      .displayID = 100,
      .displayBoundsPoints = CGRectMake(0, 0, 100, 100),
      .imageRectPixels = CGRectMake(0, 0, 10, 10),
      .destinationRectPoints = CGRectMake(0, 0, 100, 100),
      .imageToDestination = {.a = 10, .d = 10},
      .displayRotationDegrees = 0,
      .frameOrientation = MetaCaptureFrameOrientationDisplayOriented,
      .backingScaleX = 1,
      .backingScaleY = 1,
      .frameTimestampUnixNanoseconds = 1000000000,
  };
  const unsigned char png_bytes[] = {1, 2, 3};
  MetaCaptureResult capture = {
      .pngData = CFDataCreate(kCFAllocatorDefault, png_bytes, 3),
      .imageWidthPixels = 10,
      .imageHeightPixels = 10,
      .encodedBytes = 3,
      .capturedAtUnixNanoseconds = 1000000000,
      .regions = &region,
      .regionCount = 1,
  };
  MetaCaptureFrameSerializationContext frame_context = {0};
  snprintf(frame_context.binary_token, sizeof(frame_context.binary_token),
           "%s", "binary-1");
  snprintf(frame_context.frame_ref, sizeof(frame_context.frame_ref), "%s",
           "frame-1");
  memset(frame_context.sha256, 'a', 64);
  frame_context.sha256[64] = '\0';
  CFDataRef frame_data = meta_capture_frame_copy_json(&capture, &frame_context);
  assert(frame_data != NULL);
  NSDictionary *frame_json = [NSJSONSerialization
      JSONObjectWithData:(__bridge NSData *)frame_data options:0 error:&error];
  assert([frame_json[@"regions"][0][@"frameOrientation"]
      isEqualToString:@"display-oriented"]);
  CFRelease(frame_data);
  region.frameOrientation = 0;
  assert(meta_capture_frame_copy_json(&capture, &frame_context) == NULL);
  CFRelease(capture.pngData);
  meta_registry_destroy(registry);
  puts("serialization tests passed");
  return 0;
}
