#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/meta-observer-check.XXXXXX")
trap 'rm -rf -- "$CHECK_DIR"' EXIT HUP INT TERM
cd "$REPOSITORY_ROOT"

COMMON_FLAGS="-fobjc-arc -fblocks -mmacosx-version-min=13.0 -Wall -Wextra -Werror"
COMMON_INCLUDES="-Inative/include -Inative/src -Inative/src/observer -Inative/src/observer-index -Inative/src/input-observer -Inative/src/view-admission -Inative/src/recovery-domain"
COMMON_SOURCES="native/src/observer/meta_observer.m native/src/observer-index/meta_observer_target_index.m native/src/observer-command/meta_observer_command.m"

# shellcheck disable=SC2086
/usr/bin/clang $COMMON_FLAGS $COMMON_INCLUDES \
  native/src/observer/meta_observer.m \
  native/src/observer/meta_observer_test.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -o "$CHECK_DIR/observer-test"

# shellcheck disable=SC2086
/usr/bin/clang $COMMON_FLAGS $COMMON_INCLUDES $COMMON_SOURCES \
  native/src/observer-command/meta_observer_command_test.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -o "$CHECK_DIR/observer-command-test"

# shellcheck disable=SC2086
/usr/bin/clang $COMMON_FLAGS $COMMON_INCLUDES $COMMON_SOURCES \
  native/src/observer-index/meta_observer_index_builder.m \
  native/src/observer-index/meta_observer_index_builder_test.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -o "$CHECK_DIR/observer-index-builder-test"

# shellcheck disable=SC2086
/usr/bin/clang $COMMON_FLAGS $COMMON_INCLUDES $COMMON_SOURCES \
  native/src/input-observer/meta_input_observer_binding.m \
  native/src/input-observer/meta_input_observer_binding_test.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -o "$CHECK_DIR/input-observer-binding-test"

# shellcheck disable=SC2086
/usr/bin/clang $COMMON_FLAGS $COMMON_INCLUDES $COMMON_SOURCES \
  native/src/recovery-domain/meta_recovery_domain.m \
  native/src/view-admission/meta_view_admission.m \
  native/src/view-admission/meta_view_admission_test.m \
  -framework Foundation -framework AppKit -framework ApplicationServices \
  -framework Security \
  -o "$CHECK_DIR/view-admission-test"

"$CHECK_DIR/observer-test"
"$CHECK_DIR/observer-command-test"
"$CHECK_DIR/observer-index-builder-test"
"$CHECK_DIR/input-observer-binding-test"
"$CHECK_DIR/view-admission-test"
