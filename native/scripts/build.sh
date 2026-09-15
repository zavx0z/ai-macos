#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

OUTPUT=${1:-native/dist/libmeta-native.dylib}
OUTPUT_DIRECTORY=$(dirname -- "$OUTPUT")
mkdir -p "$OUTPUT_DIRECTORY"

/usr/bin/clang \
  -dynamiclib \
  -fobjc-arc \
  -fblocks \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/registry.c \
  native/src/executor.c \
  native/src/ledger.c \
  native/src/input_bridge.c \
  native/src/broker_core.c \
  native/src/macos_backend.m \
  native/src/inventory-priority/meta_inventory_priority.c \
  native/src/observer-index/meta_observer_snapshot_gate.c \
  native/src/window-actions/meta_window_readback.c \
  native/src/macos_input.m \
  native/src/serialization.m \
  native/src/capture_router.m \
  native/src/capture/meta_capture.m \
  -framework Foundation \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework CoreImage \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ImageIO \
  -framework ScreenCaptureKit \
  -o "$OUTPUT"
