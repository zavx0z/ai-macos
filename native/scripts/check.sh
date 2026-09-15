#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/meta-native-check.XXXXXX")
trap 'rm -rf -- "$CHECK_DIR"' EXIT HUP INT TERM

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/registry.c \
  -o "$CHECK_DIR/registry.o"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/executor.c \
  -o "$CHECK_DIR/executor.o"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -Inative/src/observer-index \
  native/src/observer-index/meta_observer_snapshot_gate.c \
  native/src/observer-index/meta_observer_snapshot_gate_test.c \
  -o "$CHECK_DIR/observer-snapshot-gate-test"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/ledger.c \
  -o "$CHECK_DIR/ledger.o"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/input_bridge.c \
  -o "$CHECK_DIR/input_bridge.o"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/broker_core.c \
  -o "$CHECK_DIR/broker_core.o"

/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/macos_backend.m \
  -o "$CHECK_DIR/macos_backend.o"

/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/serialization.m \
  -o "$CHECK_DIR/serialization.o"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -DMETA_CAPTURE_ROUTER_TESTING=1 \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/capture_router.m \
  -o "$CHECK_DIR/capture_router.o"

/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  -c native/src/macos_input.m \
  -o "$CHECK_DIR/macos_input.o"

if [ "${1:-}" = "--compile-only" ]; then
  exit 0
fi

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/registry.c \
  native/tests/registry_test.c \
  -o "$CHECK_DIR/registry-test"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/executor.c \
  native/src/ledger.c \
  native/tests/executor_test.c \
  -o "$CHECK_DIR/executor-test"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/ledger.c \
  native/tests/ledger_test.c \
  -o "$CHECK_DIR/ledger-test"

/usr/bin/clang \
  -std=c17 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/executor.c \
  native/src/ledger.c \
  native/src/input_bridge.c \
  native/tests/input_bridge_test.c \
  -o "$CHECK_DIR/input-bridge-test"

/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/registry.c \
  native/src/serialization.m \
  native/tests/serialization_test.m \
  -framework Foundation \
  -o "$CHECK_DIR/serialization-test"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -DMETA_CAPTURE_ROUTER_TESTING=1 \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/capture_router.m \
  native/tests/capture_router_test.m \
  -framework Foundation \
  -framework CoreGraphics \
  -o "$CHECK_DIR/capture-router-test"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -DMETA_CAPTURE_ROUTER_TESTING=1 \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/executor.c \
  native/src/ledger.c \
  native/src/capture_router.m \
  native/src/broker_core.c \
  native/tests/broker_core_test.m \
  -framework Foundation \
  -framework CoreGraphics \
  -o "$CHECK_DIR/broker-core-test"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/src/accessibility \
  native/src/accessibility/meta_ax_inspector.m \
  native/src/accessibility/meta_ax_inspector_test.m \
  -framework Foundation \
  -framework AppKit \
  -framework ApplicationServices \
  -o "$CHECK_DIR/ax-inspector-test"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/src/permissions-request \
  native/src/permissions-request/meta_permissions_request.m \
  native/src/permissions-request/meta_permissions_request_test.m \
  -framework Foundation \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -o "$CHECK_DIR/permissions-request-test"

"$CHECK_DIR/registry-test"
"$CHECK_DIR/observer-snapshot-gate-test"
"$CHECK_DIR/executor-test"
"$CHECK_DIR/ledger-test"
"$CHECK_DIR/input-bridge-test"
"$CHECK_DIR/serialization-test"
"$CHECK_DIR/capture-router-test"
"$CHECK_DIR/broker-core-test"
"$CHECK_DIR/ax-inspector-test"
"$CHECK_DIR/permissions-request-test"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -DMETA_CAPTURE_ROUTER_TESTING=1 \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -Inative/include \
  native/src/capture_router.m \
  native/tests/rotation_horizon_test.m \
  -framework Foundation \
  -framework CoreGraphics \
  -o "$CHECK_DIR/rotation-horizon-test"

"$CHECK_DIR/rotation-horizon-test"

sh native/scripts/check-observer.sh
