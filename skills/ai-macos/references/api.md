# ai-macos MCP tool map

The repository at `~/repozitarium/ai-macos` on the current Mac is authoritative for
implementation details. This reference describes the direct MCP surface exposed
to agents. It contains no REST fallback.

## Preflight and targeting

1. `mcp__ai_macos__system_health`
2. Verify `machine.matchesExpected === true`.
3. Before pointer or keyboard input only:
   `mcp__ai_macos__input_readiness`.
4. Before a window-targeted action only: `mcp__ai_macos__list_windows`.
5. `mcp__ai_macos__capture_window` or `capture_desktop`.

Stop when health reports a required capability unavailable. MCP does not grant
or request macOS privacy permissions. The separate active input readiness probe
moves the pointer by one logical pixel and restores it after machine identity is
verified. Pointer and keyboard work requires `inputReady: true`; clipboard
work requires `clipboardReady: true` and does not require the active probe.

## Observation

- `capture_desktop({caption})` captures the desktop at medium detail.
- `capture_window({app,pid?,windowId?,index?,title?,caption})` captures one visible window and
  returns its window-local coordinate space.
- `latest_capture` is private support for the optional screenshot PiP.
- `open_screenshot_pip` opens the one viewer only when the user asks to see it.

Always compare a capture with its caption before acting.

## Window and input

- `focus_window` focuses an already visible exact target.
- `arrange_window` applies a bounded layout preset.
- `mouse_position` reads the pointer position.
- `mouse_move` moves without clicking.
- `mouse_click` accepts window-local coordinates for a verified target.
- `mouse_scroll`, `keyboard_type`, `keyboard_key`, and `keyboard_shortcut`
  perform a verified target transaction and require visual verification.
- `mouse_scroll` uses native wheel **lines**, not pixels. Positive `dy` moves
  down, negative up. Start with about 8 lines, inspect the returned capture, and
  adjust. Hundreds of lines can skip the whole document; do not reuse pixel
  deltas from another automation API. The actual visual distance depends on
  the application and system scrolling behavior.
- `clipboard_read` requires an explicit user request to inspect content.
- `clipboard_write` writes plain text without UI shortcuts.

## Save/Open sheet sequence

1. Keep the parent's `{app,pid,windowId}` from `list_windows` when advertised.
   For older schemas use a unique title or freshly discovered index. A sheet's
   `ownerWindowId` points to the parent; do not target its diagnostic index 0.
2. Capture the parent window with a caption naming the expected dialog.
3. Type into the visibly focused filename field, or click a field using
   parent-window-local coordinates. Inspect the verification capture.
4. Use `keyboard_shortcut` with `cmd+shift+g` for a directory, then
   `keyboard_type` with the authorized absolute path. Verify before Enter.
5. Verify the selected directory and filename before Save/Open, and verify
   the resulting file or editor state afterward.

September 14, 2026 regression: the old running window service reported a
Yandex save sheet as `window: null` and rejected input after restoring focus
to ChatGPT. Updating the checkout alone left that service running. The native
backend from `0bd9eaf` reports its geometry as `index: 0`; after updating the
affected services, typing into the same dialog succeeded. Screenshot focus
restoration must leave an unchanged sheet focused or resolve a unique owner;
it must not call `/focus` with the unlisted sheet as a top-level window.

## Deprecated connector and unsupported modes

The app/plugin connector namespace `mcp__codex_apps__ai_macos_local_*` is
deprecated, must not be used, and remains an external archival gate. A current
task may still display those tools from an old catalog; that does not authorize
the connector.

The direct MCP currently exposes window, screen, input, and clipboard tools.
When Chrome- or Android-specific direct tools are absent, stop with a precise
coverage gap. Never use `curl` against ports 7878-7882 as a fallback.

## Stable ID evidence

MCP 0.3.0 passes `windowId` through focus, post-input readback, capture and focus
restoration. The native selector is resolved in the same helper call that acts
on its AX element. A screenshot resolves the current window by CGWindowID, captures its visible
composite (including menus), and rejects a changed frame or missing ID afterward. Save/Open compositing was checked visually on Yandex.

[CGWindowNumber](https://developer.apple.com/documentation/coregraphics/kcgwindownumber)
is unique within the current user session. Prefer `pid + windowId`; rediscover
after the window closes or the application restarts. See [incident evidence](incidents.md).
