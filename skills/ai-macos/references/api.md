# ai-macos REST quick reference

The repository's `/Users/admin/repozitarium/ai-macos/AGENTS.md` is authoritative. Use this file as a compact map, not as a replacement for the current repository instructions.

## Services

| Service | Port | Purpose |
|---|---:|---|
| `@meta/window` | 7878 | Window discovery, focus, geometry, raise, pin, Accessibility status |
| `@meta/screen` | 7879 | Desktop, window, and rectangular screenshots; Screen Recording status |
| `@meta/chrome` | 7880 | Desktop Chrome windows, tabs, CDP/AppleScript navigation, content, screenshots |
| `@meta/android` | 7881 | Android Chrome through ADB and CDP |
| `@meta/input` | 7882 | Native CoreGraphics mouse and keyboard input |

## Required preflight

Call `/health` before the first operation on every service used:

```bash
curl -sS http://localhost:7878/health
curl -sS http://localhost:7879/health
curl -sS http://localhost:7880/health
curl -sS http://localhost:7881/health
curl -sS http://localhost:7882/health
```

The input health response must report `ok: true`, `backend: "native-helper"`, and `accessibility: true` before mouse or keyboard actions.

Permission checks:

```bash
curl -sS http://localhost:7878/permissions/accessibility
curl -sS -X POST http://localhost:7878/permissions/accessibility
curl -sS http://localhost:7879/permissions/screen-recording
curl -sS -X POST http://localhost:7879/permissions/screen-recording
curl -sS -X POST http://localhost:7882/permissions/accessibility
```

When a check returns `granted: false`, use the matching POST once, report the opened settings page, and stop the blocked operation.

## Observe the desktop

List windows before targeting an app:

```bash
curl -sS http://localhost:7878/windows
curl -sS 'http://localhost:7878/windows?app=System%20Settings'
```

Capture a desktop screenshot with an explicit expectation:

```bash
curl -sS -X POST http://localhost:7879/desktop \
  -H 'content-type: application/json' \
  -d '{"detail":"medium","caption":"Ожидаю увидеть окно System Settings на странице Accessibility"}' \
  -o desktop.png
```

Capture a particular application window:

```bash
curl -sS -X POST http://localhost:7879/window \
  -H 'content-type: application/json' \
  -d '{"app":"System Settings","detail":"medium","caption":"Ожидаю увидеть активное окно настроек конфиденциальности"}' \
  -o settings.png
```

Inspect each PNG with `view_image` before computing input coordinates.

## Focus and native input

Focus an app using its canonical name from `/windows`:

```bash
curl -sS -X POST http://localhost:7878/focus \
  -H 'content-type: application/json' \
  -d '{"app":"System Settings"}'
```

Mouse:

```bash
curl -sS http://localhost:7882/mouse/position
curl -sS -X POST http://localhost:7882/mouse/move \
  -H 'content-type: application/json' -d '{"x":500,"y":400}'
curl -sS -X POST http://localhost:7882/mouse/click \
  -H 'content-type: application/json' -d '{"x":500,"y":400,"button":"left","count":1}'
curl -sS -X POST http://localhost:7882/mouse/drag \
  -H 'content-type: application/json' \
  -d '{"from":{"x":100,"y":100},"to":{"x":300,"y":300}}'
curl -sS -X POST http://localhost:7882/mouse/scroll \
  -H 'content-type: application/json' -d '{"dy":3}'
```

Keyboard:

```bash
curl -sS -X POST http://localhost:7882/keyboard/type \
  -H 'content-type: application/json' -d '{"text":"Hello","delayMs":30}'
curl -sS -X POST http://localhost:7882/keyboard/key \
  -H 'content-type: application/json' -d '{"key":"enter"}'
curl -sS -X POST http://localhost:7882/keyboard/shortcut \
  -H 'content-type: application/json' -d '{"shortcut":"cmd+shift+t"}'
```

After each consequential action, take and inspect another captioned screenshot.

## Desktop Chrome

Always begin with:

```bash
curl -sS http://localhost:7880/windows
```

Choose a window with `kind: "browser"` and a concrete tab from its `tabs` array. Carry both identifiers through every operation:

```bash
curl -sS -X POST http://localhost:7880/activate \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'

curl -sS -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"detail":"medium","caption":"Ожидаю увидеть страницу настроек приложения"}' \
  -o chrome.png
```

Never send an `appWindow` to tab endpoints. Read `/Users/admin/repozitarium/ai-macos/chrome/API.md` and the Chrome section of `AGENTS.md` before navigation, evaluation, console capture, viewport manipulation, or CDP work.

## Android Chrome

Check `http://localhost:7881/health` and `http://localhost:7881/devices`, then retain the concrete CDP `tabId` returned by `/tabs`. Read the Android section of the repository `AGENTS.md` before bootstrapping ADB, forwarding ports, or modifying a tab.
