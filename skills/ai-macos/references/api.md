# ai-macos MCP tool map

The repository at `/Users/zavx0z/repozitarium/ai-macos` is authoritative for
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
- `capture_window({app,index?,title?,caption})` captures one visible window and
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
- `clipboard_read` requires an explicit user request to inspect content.
- `clipboard_write` writes plain text without UI shortcuts.

## Deprecated connector and unsupported modes

The app/plugin connector namespace `mcp__codex_apps__ai_macos_local_*` is
deprecated, must not be used, and remains an external archival gate. A current
task may still display those tools from an old catalog; that does not authorize
the connector.

The direct MCP currently exposes window, screen, input, and clipboard tools.
When Chrome- or Android-specific direct tools are absent, stop with a precise
coverage gap. Never use `curl` against ports 7878-7882 as a fallback.
