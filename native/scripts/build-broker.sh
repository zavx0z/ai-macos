#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

if [ "$#" -ne 2 ]; then
  echo "Использование: build-broker.sh <candidate-output> <build-id>" >&2
  exit 64
fi
CANDIDATE_OUTPUT=$1
CANDIDATE_BUILD_ID=$2
case "$CANDIDATE_OUTPUT" in
  */input/bin/meta-input-helper|input/bin/meta-input-helper)
    echo "Сборка требует временный candidate path" >&2
    exit 64
    ;;
esac
mkdir -p "$(dirname -- "$CANDIDATE_OUTPUT")"

/usr/bin/clang \
  -fobjc-arc -fblocks -mmacosx-version-min=13.0 \
  -Wall -Wextra -Werror -Inative/include -Inative/src \
  "-DMETA_NATIVE_BUILD_ID=\"$CANDIDATE_BUILD_ID\"" \
  "-DMETA_NATIVE_INSTALL_ROOT=\"$REPOSITORY_ROOT\"" \
  native/src/registry.c native/src/executor.c native/src/ledger.c \
  native/src/input_bridge.c native/src/broker_core.c \
  native/src/macos_backend.m native/src/macos_input.m \
  native/src/serialization.m native/src/capture_router.m \
  native/src/capture/meta_capture.m native/src/clipboard/meta_clipboard.m \
  native/src/command_loop.m native/src/broker_transport.m native/src/broker_main.m \
  native/src/input_job.m native/src/input_executor.m \
  native/src/session_identity.c -lbsm \
  native/src/accessibility/meta_ax_inspector.m \
  native/src/ax_request.m \
  native/src/window-actions/meta_window_readback.c \
  native/src/window-actions/meta_window_actions.c native/src/window-actions/meta_window_actions_macos.m \
  native/src/window-actions/meta_window_result.m \
  native/src/code-identity/meta_code_identity.m \
  native/src/input-target/meta_point_target.m \
  native/src/operation-receipts/meta_operation_receipts.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -framework CoreGraphics -framework CoreImage -framework CoreMedia \
  -framework CoreVideo -framework ImageIO -framework ScreenCaptureKit \
  -framework Security \
  -o "$CANDIDATE_OUTPUT"
