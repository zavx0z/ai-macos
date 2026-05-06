---
name: macos-window
description: Query, focus, move, resize, and arrange macOS windows by calling the @meta/window REST API (default http://localhost:7878). Use whenever the user asks to inspect or rearrange application windows on macOS.
---

# macos-window

A REST API for controlling macOS windows lives at `http://localhost:7878` (override via `WINDOW_API`). Source: `~/meta/macos/window`.

## Prerequisites

1. **Server must be running**:
   ```bash
   cd ~/meta/macos/window && bun src/index.ts
   ```
   Or via workspace: `cd ~/meta && bun run --filter '@meta/window' dev`.

2. **Accessibility permission** is required for `list/move/resize/arrange` (everything except `focus`). Grant it to the process that runs `bun` (usually iTerm2 / Terminal / Claude Code):
   - System Settings → Privacy & Security → Accessibility → toggle the parent terminal app ON.
   - Symptom of missing permission: `/windows` returns `count: 0` and `osascript` errors with code `-25211`.

3. Do **not** invoke any other window manager (yabai, Hammerspoon) for these tasks — always go through this API so behavior stays consistent.

## CLI

The package exposes a CLI at `~/meta/macos/window/src/cli.ts`. Run via:

```bash
bun ~/meta/macos/window/src/cli.ts <cmd> [flags]
# or, after `bun link` inside the package:
window <cmd> [flags]
```

Commands:
- `health` → `{ ok: true }`
- `screen` → `{ width, height }` of main display
- `list [--app "Name"]` → all visible windows (optionally filtered)
- `focus --app "Name"` → bring app to front
- `move --app "Name" --x 0 --y 0 [--index 1]`
- `resize --app "Name" --width 1200 --height 800 [--index 1]`
- `arrange --app "Name" --preset left|right|top|bottom|max|center [--index 1]`
- `raise --app "Name" [--index 1]` — one-shot AXRaise, no focus steal
- `pin --app "Name" [--index 1] [--interval 500]` — soft "always on top"
- `pins` — list active pins
- `unpin --id <id>` / `unpin-all`

`--index` is 1-based; window 1 is the frontmost window of the app.

## REST endpoints

| Method | Path        | Body                                         | Notes                                              |
|--------|-------------|----------------------------------------------|----------------------------------------------------|
| GET    | `/health`   | —                                            | liveness                                           |
| GET    | `/screen`   | —                                            | main-display logical size                          |
| GET    | `/windows`  | (query `?app=Name` optional)                 | array of `{app,pid,index,title,x,y,width,height}`  |
| POST   | `/focus`    | `{ app }`                                    | activates app (no Accessibility needed)            |
| POST   | `/move`     | `{ app, x, y, index? }`                      | absolute screen coords                             |
| POST   | `/resize`   | `{ app, width, height, index? }`             | logical pixels                                     |
| POST   | `/arrange`  | `{ app, preset, index? }`                    | preset: `left,right,top,bottom,max,center`         |
| POST   | `/raise`    | `{ app, index? }`                            | one-shot AXRaise, не отнимает фокус                |
| POST   | `/pin`      | `{ app, index?, intervalMs? }`               | soft "always on top" — фоновый цикл AXRaise        |
| GET    | `/pin`      | —                                            | список активных pin                                |
| DELETE | `/pin/:id`  | —                                            | снять один pin                                     |
| DELETE | `/pin`      | —                                            | снять все pin                                      |

## How to use this skill

1. **Always start by checking the server is up**:
   ```bash
   curl -fsS http://localhost:7878/health
   ```
   If it fails, tell the user to start it with `bun ~/meta/macos/window/src/index.ts` (or offer to start it in the background).

2. **To find a window**, prefer `GET /windows?app=<Name>` over listing everything — faster and easier to disambiguate. Match `app` exactly (case-sensitive).

3. **For tiling-style layouts**, use `/arrange` with a preset rather than computing coords manually. Reach for `/move` + `/resize` only for exact placements the user asks for.

4. **Coordinate system**: origin `(0,0)` is the top-left of the main display, in logical pixels. Use `GET /screen` to read display size before computing custom positions.

5. **Multiple windows**: pass `index` (1 = frontmost). If unsure, `GET /windows?app=X` lists them with their indexes.

6. **Errors**: a `500` with `osascript failed (1): ...` and code `-25211` means Accessibility is not granted — surface that to the user, do not retry blindly.

7. **"Always on top" requests** ("сделай поверх", "держи всегда сверху", "закрепи поверх окон"):
   - Use `POST /pin` (NOT `/raise`, that's one-shot).
   - Default `intervalMs: 500` is a good balance; ask the user if they
     want it tighter (e.g. 200) or looser (1000).
   - **Do not promise "true topmost"** — explain it's a soft loop, full-
     screen apps still cover, some apps ignore AXRaise (`errors` grows).
   - Always tell the user the `id` returned so they can `DELETE /pin/:id`
     later, or remind them `DELETE /pin` clears all.
   - Pins are lost on server restart — mention this if they ask why
     pinning stopped.

## Examples

```bash
# What's open?
curl -s http://localhost:7878/windows | jq '.windows[] | {app, title, x, y, width, height}'

# Snap iTerm2 to left half
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2","preset":"left"}' \
  http://localhost:7878/arrange

# Move Safari to (200, 120) and resize to 1400x900
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari","x":200,"y":120}' http://localhost:7878/move
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari","width":1400,"height":900}' http://localhost:7878/resize

# Bring Finder to front
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Finder"}' http://localhost:7878/focus

# Soft "always on top" for iTerm2 (raises every 500 ms, no focus steal)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2","intervalMs":500}' http://localhost:7878/pin
# → returns { pin: { id: "1", ... } } — use that id to unpin later
curl -s -X DELETE http://localhost:7878/pin/1

# Stop all pins
curl -s -X DELETE http://localhost:7878/pin
```

## Project layout

```
~/meta/                        # Bun monorepo root (workspaces: macos/*)
├── package.json
├── tsconfig.base.json
└── macos/
    └── window/
        ├── package.json       # name: @meta/window, bin: window
        ├── tsconfig.json
        └── src/
            ├── index.ts       # Bun.serve REST server
            ├── cli.ts         # CLI client
            ├── windows.ts     # osascript-backed window ops
            └── osascript.ts   # thin spawn wrapper
```
