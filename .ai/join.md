# Проект

├── src/
│   ├── chrome.ts
│   ├── cli.ts
│   └── index.ts
└── API.md

```markdown
/Users/vladimirfilipenko/meta/macos/chrome/API.md
# @meta/chrome

Локальный REST‑сервис для управления Google Chrome на macOS через AppleScript.

- База: `$CHROME_API` или `http://localhost:7880`.
- JSON in / JSON out (кроме `/source` и `/text` — они возвращают `text/html` и `text/plain`).
- Все операции выполняются через `osascript` поверх AppleScript‑словаря Google Chrome.
- Идентификаторы окон (`id`) и индексы вкладок (`index`) возвращаются эндпоинтом `GET /windows`.

## Запуск

```bash
cd macos/chrome
bun run dev    # с hot reload
bun run start  # обычный запуск
```

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `7880`).
- `CHROME_API` — база для CLI (по умолчанию `http://localhost:7880`).

## Разрешения

- AppleScript‑автоматизация: при первом обращении macOS попросит разрешить процессу управление Google Chrome.
- Для `/eval`, `/source`, `/text` нужно включить в Chrome: **View → Developer → Allow JavaScript from Apple Events**. Без этого `execute javascript` возвращает ошибку.

## Эндпоинты

### `GET /health`

```json
{ "ok": true, "running": true }
```

### `GET /windows`

Список всех окон Chrome со вложенными вкладками.

```json
{
  "count": 1,
  "windows": [
    {
      "id": 12345, "index": 1, "title": "GitHub",
      "x": 0, "y": 0, "width": 1440, "height": 900,
      "activeTabIndex": 2, "mode": "normal",
      "tabs": [
        { "id": 1, "index": 1, "title": "Inbox", "url": "https://...", "loading": false },
        { "id": 2, "index": 2, "title": "GitHub", "url": "https://...", "loading": false }
      ]
    }
  ]
}
```

### `POST /windows`

Открыть новое окно.

```json
{ "url": "https://example.com", "incognito": false }
```

### `DELETE /windows/:id`

Закрыть окно по `id`.

### `GET /tabs[?windowId=N]`

Плоский список вкладок. Без параметра — по всем окнам, иначе — только из заданного окна.

### `GET /tabs/active`

Информация о текущей активной вкладке переднего окна.

### `POST /tabs`

Открыть новую вкладку.

```json
{ "windowId": 12345, "url": "https://example.com" }
```

`windowId` опционален — без него вкладка создаётся в переднем окне.

### `DELETE /tabs/:windowId/:index`

Закрыть конкретную вкладку.

### `POST /navigate`

Перейти по URL в указанной (или активной) вкладке.

```json
{ "url": "https://example.com", "windowId": 12345, "tabIndex": 2 }
```

### `POST /activate`

Сделать вкладку активной в окне.

```json
{ "windowId": 12345, "tabIndex": 3 }
```

### `POST /reload | /back | /forward`

```json
{ "windowId": 12345, "tabIndex": 2 }
```

Все поля опциональны — без них действие идёт в активной вкладке переднего окна.

`POST /reload` дополнительно принимает `{ "hard": true }`. В этом случае выполняется **жёсткая перезагрузка с обходом кеша** через симуляцию `Cmd+Shift+R`. Реализация: AppleScript поднимает целевое окно (`set index of window id W to 1`), активирует вкладку, выводит Chrome на передний план и шлёт keystroke через System Events. Это **переносит фокус** на Chrome — обычный `reload` (без `hard`) фокус не трогает. Жёсткая перезагрузка не требует «Allow JavaScript from Apple Events», но требует разрешения Accessibility для процесса, посылающего Apple events (как и любая другая операция System Events).

### `POST /eval`

Выполнить JavaScript в контексте вкладки. JS оборачивается в IIFE, результат сериализуется через `JSON.stringify`.

```json
{ "js": "return document.title", "windowId": 12345, "tabIndex": 2 }
```

```json
{ "ok": true, "result": "GitHub" }
```

### `GET /source[?windowId=N&tabIndex=N]`

Возвращает `document.documentElement.outerHTML` как `text/html`.

### `GET /text[?windowId=N&tabIndex=N]`

Возвращает `document.body.innerText` как `text/plain`.

### `GET /screenshot[?windowId=N&tabIndex=N&shadow=false&delayMs=200&format=png|json]`

Скриншот окна Chrome, в котором лежит указанная вкладка. Если `tabIndex` задан и отличается от текущей активной, вкладка предварительно активируется. Запрос проксируется в `@meta/screen` (`POST /window`) с `app="Google Chrome"` и `title=` равным заголовку окна, поэтому для работы нужны живые `@meta/screen` и `@meta/window`.

`POST /screenshot` принимает то же тело JSON. На выходе — `image/png` (или JSON с base64 при `format=json`). Захватывается всё окно Chrome целиком (включая адресную строку и панель вкладок), а не только viewport.

## CLI

```
chrome health
chrome windows
chrome tabs [--window <id>]
chrome active
chrome new-window  [--url <url>] [--incognito]
chrome close-window --window <id>
chrome new-tab     [--window <id>] [--url <url>]
chrome close-tab    --window <id> --index <n>
chrome activate     --window <id> --index <n>
chrome navigate     --url <url> [--window <id>] [--index <n>]
chrome reload       [--window <id>] [--index <n>] [--hard]
chrome back         [--window <id>] [--index <n>]
chrome forward      [--window <id>] [--index <n>]
chrome eval         --js "<code>" [--window <id>] [--index <n>]
chrome source       [--window <id>] [--index <n>]
chrome text         [--window <id>] [--index <n>]
chrome screenshot   [--window <id>] [--index <n>] [--out <path>] [--shadow false] [--delayMs 200]
```

`chrome screenshot` без `--out` сохраняет PNG в `./tmp/screenshots/chrome-<ts>.png` и печатает JSON `{ ok, path, bytes }`.

```

```typescript
/Users/vladimirfilipenko/meta/macos/chrome/src/chrome.ts
import { osa, quote } from "./osascript.ts";

export type TabInfo = {
  id: number;
  index: number;
  title: string;
  url: string;
  loading: boolean;
};

export type WindowInfo = {
  id: number;
  index: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  activeTabIndex: number;
  mode: string;
  tabs: TabInfo[];
};

const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);
const TS = String.fromCharCode(29);

const LIST_SCRIPT = `
set fs to (ASCII character 31)
set rs to (ASCII character 30)
set ts to (ASCII character 29)
set out to ""
if application "Google Chrome" is not running then return ""
tell application "Google Chrome"
  set winList to every window
  set wIdx to 0
  repeat with w in winList
    set wIdx to wIdx + 1
    try
      set wId to id of w
    on error
      set wId to 0
    end try
    try
      set wTitle to title of w
    on error
      set wTitle to ""
    end try
    try
      set {wx, wy, wx2, wy2} to bounds of w
    on error
      set wx to 0
      set wy to 0
      set wx2 to 0
      set wy2 to 0
    end try
    try
      set wActive to active tab index of w
    on error
      set wActive to 0
    end try
    try
      set wMode to mode of w
    on error
      set wMode to ""
    end try
    set out to out & wId & fs & wIdx & fs & wTitle & fs & wx & fs & wy & fs & (wx2 - wx) & fs & (wy2 - wy) & fs & wActive & fs & wMode
    set tabList to every tab of w
    set tIdx to 0
    repeat with t in tabList
      set tIdx to tIdx + 1
      try
        set tId to id of t
      on error
        set tId to 0
      end try
      try
        set tTitle to title of t
      on error
        set tTitle to ""
      end try
      try
        set tUrl to URL of t
      on error
        set tUrl to ""
      end try
      try
        set tLoading to loading of t
      on error
        set tLoading to false
      end try
      set out to out & ts & tId & fs & tIdx & fs & tTitle & fs & tUrl & fs & tLoading
    end repeat
    set out to out & rs
  end repeat
end tell
return out
`;

export async function listWindows(): Promise<WindowInfo[]> {
  const raw = await osa(LIST_SCRIPT);
  if (!raw) return [];
  return raw
    .split(RS)
    .filter((r) => r.length > 0)
    .map(parseWindowRecord);
}

function parseWindowRecord(rec: string): WindowInfo {
  const parts = rec.split(TS);
  const head = parts[0] ?? "";
  const [id, index, title, x, y, width, height, activeTabIndex, mode] = head.split(FS);
  const tabs: TabInfo[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (!p) continue;
    const [tId, tIdx, tTitle, tUrl, tLoading] = p.split(FS);
    tabs.push({
      id: Number(tId ?? 0),
      index: Number(tIdx ?? 0),
      title: tTitle ?? "",
      url: tUrl ?? "",
      loading: (tLoading ?? "false") === "true",
    });
  }
  return {
    id: Number(id ?? 0),
    index: Number(index ?? 0),
    title: title ?? "",
    x: Number(x ?? 0),
    y: Number(y ?? 0),
    width: Number(width ?? 0),
    height: Number(height ?? 0),
    activeTabIndex: Number(activeTabIndex ?? 0),
    mode: mode ?? "",
    tabs,
  };
}

export async function getActiveTab(): Promise<TabInfo & { windowId: number } | null> {
  const wins = await listWindows();
  if (wins.length === 0) return null;
  const w = wins[0]!;
  const tab = w.tabs.find((t) => t.index === w.activeTabIndex) ?? w.tabs[0];
  if (!tab) return null;
  return { ...tab, windowId: w.id };
}

function windowRef(windowId?: number): string {
  return windowId == null ? "front window" : `window id ${windowId}`;
}

function tabRef(windowId?: number, tabIndex?: number): string {
  if (tabIndex == null) return `active tab of ${windowRef(windowId)}`;
  return `tab ${tabIndex} of ${windowRef(windowId)}`;
}

export type NewWindowOptions = {
  url?: string;
  incognito?: boolean;
};

export async function newWindow(options: NewWindowOptions = {}): Promise<{ id: number }> {
  const props: string[] = [];
  if (options.incognito) props.push(`mode:"incognito"`);
  const propsExpr = props.length ? ` with properties {${props.join(", ")}}` : "";
  const script = `
    tell application "Google Chrome"
      activate
      set w to make new window${propsExpr}
      ${options.url ? `set URL of active tab of w to ${quote(options.url)}` : ""}
      return id of w
    end tell
  `;
  const out = await osa(script);
  return { id: Number(out) };
}

export async function closeWindow(windowId: number): Promise<void> {
  await osa(`tell application "Google Chrome" to close window id ${windowId}`);
}

export type NewTabOptions = {
  windowId?: number;
  url?: string;
};

export async function newTab(options: NewTabOptions = {}): Promise<{ id: number; index: number }> {
  const target = windowRef(options.windowId);
  const propsExpr = options.url ? ` with properties {URL:${quote(options.url)}}` : "";
  const script = `
    tell application "Google Chrome"
      activate
      tell ${target}
        set t to make new tab at end of tabs${propsExpr}
        set tIdx to count of tabs
        return (id of t as string) & "|" & tIdx
      end tell
    end tell
  `;
  const out = await osa(script);
  const [id, idx] = out.split("|");
  return { id: Number(id ?? 0), index: Number(idx ?? 0) };
}

export async function closeTab(windowId: number, tabIndex: number): Promise<void> {
  await osa(
    `tell application "Google Chrome" to close tab ${tabIndex} of window id ${windowId}`,
  );
}

export async function activateTab(windowId: number, tabIndex: number): Promise<void> {
  await osa(
    `tell application "Google Chrome" to set active tab index of window id ${windowId} to ${tabIndex}`,
  );
}

export async function navigate(
  url: string,
  windowId?: number,
  tabIndex?: number,
): Promise<void> {
  await osa(
    `tell application "Google Chrome" to set URL of ${tabRef(windowId, tabIndex)} to ${quote(url)}`,
  );
}

export async function reload(windowId?: number, tabIndex?: number): Promise<void> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to reload`);
}

export async function hardReload(windowId?: number, tabIndex?: number): Promise<void> {
  if (windowId != null) {
    await osa(`tell application "Google Chrome" to set index of window id ${windowId} to 1`);
  }
  if (tabIndex != null) {
    const target = windowId != null ? `window id ${windowId}` : "front window";
    await osa(`tell application "Google Chrome" to set active tab index of ${target} to ${tabIndex}`);
  }
  await osa(`
    tell application "Google Chrome" to activate
    delay 0.05
    tell application "System Events" to tell process "Google Chrome"
      keystroke "r" using {command down, shift down}
    end tell
  `);
}

export async function goBack(windowId?: number, tabIndex?: number): Promise<void> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to go back`);
}

export async function goForward(windowId?: number, tabIndex?: number): Promise<void> {
  await osa(`tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to go forward`);
}

export async function evalJs(
  js: string,
  windowId?: number,
  tabIndex?: number,
): Promise<string> {
  const wrapped = `(function(){try{var __r=(function(){${js}})();return (typeof __r==='undefined')?'':(typeof __r==='string'?__r:JSON.stringify(__r));}catch(e){throw e;}})()`;
  return await osa(
    `tell application "Google Chrome" to tell ${tabRef(windowId, tabIndex)} to execute javascript ${quote(wrapped)}`,
  );
}

export async function getSource(windowId?: number, tabIndex?: number): Promise<string> {
  return await evalJs("return document.documentElement.outerHTML;", windowId, tabIndex);
}

export async function getText(windowId?: number, tabIndex?: number): Promise<string> {
  return await evalJs("return document.body && document.body.innerText || '';", windowId, tabIndex);
}

export async function isRunning(): Promise<boolean> {
  const out = await osa(`tell application "System Events" to (name of processes) contains "Google Chrome"`);
  return out === "true";
}

const SCREEN_API = Bun.env.SCREEN_API ?? "http://localhost:7879";

export type ScreenshotOptions = {
  windowId?: number;
  tabIndex?: number;
  shadow?: boolean;
  delayMs?: number;
  format?: "png" | "json";
  restore?: boolean;
};

export type ScreenshotResult = {
  status: number;
  contentType: string;
  body: ArrayBuffer;
};

export async function screenshotTab(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const wins = await listWindows();
  if (wins.length === 0) throw new Error("no Chrome windows");
  const target = opts.windowId != null
    ? wins.find((w) => w.id === opts.windowId)
    : wins.find((w) => w.index === 1) ?? wins[0];
  if (!target) throw new Error(`window not found: id=${opts.windowId}`);

  if (opts.tabIndex != null && opts.tabIndex !== target.activeTabIndex) {
    const tabExists = target.tabs.some((t) => t.index === opts.tabIndex);
    if (!tabExists) throw new Error(`tab ${opts.tabIndex} not found in window ${target.id}`);
    await activateTab(target.id, opts.tabIndex);
  }

  const fresh = (await listWindows()).find((w) => w.id === target.id) ?? target;

  const body: Record<string, unknown> = {
    app: "Google Chrome",
    title: fresh.title,
    restore: opts.restore !== false,
    format: opts.format ?? "png",
  };
  if (opts.shadow !== undefined) body.shadow = opts.shadow;
  if (opts.delayMs !== undefined) body.delayMs = opts.delayMs;

  const res = await fetch(`${SCREEN_API}/window`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const buf = await res.arrayBuffer();
  if (!res.ok) {
    const text = new TextDecoder().decode(buf);
    throw new Error(`screen api ${res.status}: ${text}`);
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    body: buf,
  };
}

```

```typescript
/Users/vladimirfilipenko/meta/macos/chrome/src/cli.ts
#!/usr/bin/env bun
export {};
const BASE = Bun.env.CHROME_API ?? "http://localhost:7880";

type Args = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; args: Args; positional: string[] } {
  const [cmd = "", ...rest] = argv;
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next != null && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, args, positional };
}

async function get(path: string, asText = false): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body);
  }
  return asText ? await res.text() : await res.json();
}

async function send(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pretty(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function help(): never {
  console.log(`chrome — REST CLI for @meta/chrome (base: ${BASE})

usage:
  chrome health
  chrome windows
  chrome tabs [--window <id>]
  chrome active
  chrome new-window  [--url <url>] [--incognito]
  chrome close-window --window <id>
  chrome new-tab     [--window <id>] [--url <url>]
  chrome close-tab    --window <id> --index <n>
  chrome activate     --window <id> --index <n>
  chrome navigate     --url <url> [--window <id>] [--index <n>]
  chrome reload       [--window <id>] [--index <n>] [--hard]
  chrome back         [--window <id>] [--index <n>]
  chrome forward      [--window <id>] [--index <n>]
  chrome eval         --js "<code>" [--window <id>] [--index <n>]
  chrome source       [--window <id>] [--index <n>]
  chrome text         [--window <id>] [--index <n>]
  chrome screenshot   [--window <id>] [--index <n>] [--out <path>] [--shadow false] [--delayMs 200]

env:
  CHROME_API   override API base (default http://localhost:7880)
`);
  process.exit(0);
}

function targetBody(args: Args): { windowId?: number; tabIndex?: number } {
  const out: { windowId?: number; tabIndex?: number } = {};
  if (args.window) out.windowId = Number(args.window);
  if (args.index) out.tabIndex = Number(args.index);
  return out;
}

const { cmd, args } = parseArgs(Bun.argv.slice(2));

try {
  switch (cmd) {
    case "":
    case "help":
    case "-h":
    case "--help":
      help();

    case "health":
      console.log(pretty(await get("/health")));
      break;

    case "windows":
      console.log(pretty(await get("/windows")));
      break;

    case "tabs": {
      const q = args.window ? `?windowId=${encodeURIComponent(args.window)}` : "";
      console.log(pretty(await get(`/tabs${q}`)));
      break;
    }

    case "active":
      console.log(pretty(await get("/tabs/active")));
      break;

    case "new-window": {
      const body: Record<string, unknown> = {};
      if (args.url) body.url = args.url;
      if (args.incognito) body.incognito = true;
      console.log(pretty(await send("POST", "/windows", body)));
      break;
    }

    case "close-window": {
      if (!args.window) throw new Error("--window required");
      console.log(pretty(await send("DELETE", `/windows/${encodeURIComponent(args.window)}`)));
      break;
    }

    case "new-tab": {
      const body: Record<string, unknown> = {};
      if (args.window) body.windowId = Number(args.window);
      if (args.url) body.url = args.url;
      console.log(pretty(await send("POST", "/tabs", body)));
      break;
    }

    case "close-tab": {
      if (!args.window || !args.index) throw new Error("--window and --index required");
      console.log(pretty(await send("DELETE", `/tabs/${encodeURIComponent(args.window)}/${encodeURIComponent(args.index)}`)));
      break;
    }

    case "activate": {
      if (!args.window || !args.index) throw new Error("--window and --index required");
      console.log(pretty(await send("POST", "/activate", { windowId: Number(args.window), tabIndex: Number(args.index) })));
      break;
    }

    case "navigate": {
      if (!args.url) throw new Error("--url required");
      console.log(pretty(await send("POST", "/navigate", { url: args.url, ...targetBody(args) })));
      break;
    }

    case "reload": {
      const body: Record<string, unknown> = { ...targetBody(args) };
      if (args.hard) body.hard = true;
      console.log(pretty(await send("POST", "/reload", body)));
      break;
    }

    case "back":
      console.log(pretty(await send("POST", "/back", targetBody(args))));
      break;

    case "forward":
      console.log(pretty(await send("POST", "/forward", targetBody(args))));
      break;

    case "eval": {
      if (!args.js) throw new Error("--js required");
      console.log(pretty(await send("POST", "/eval", { js: args.js, ...targetBody(args) })));
      break;
    }

    case "source": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      const qs = params.toString();
      console.log(await get(`/source${qs ? `?${qs}` : ""}`, true));
      break;
    }

    case "text": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      const qs = params.toString();
      console.log(await get(`/text${qs ? `?${qs}` : ""}`, true));
      break;
    }

    case "screenshot": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      if (args.shadow) params.set("shadow", args.shadow);
      if (args.delayMs) params.set("delayMs", args.delayMs);
      const qs = params.toString();
      const res = await fetch(`${BASE}/screenshot${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error(await res.text());
      const buf = new Uint8Array(await res.arrayBuffer());
      const out = args.out ?? `./tmp/screenshots/chrome-${Date.now()}.png`;
      const parent = out.slice(0, out.lastIndexOf("/"));
      if (parent.length > 0) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(parent, { recursive: true });
      }
      await Bun.write(out, buf);
      console.log(JSON.stringify({ ok: true, path: out, bytes: buf.byteLength }, null, 2));
      break;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      help();
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  process.exit(1);
}

```

```typescript
/Users/vladimirfilipenko/meta/macos/chrome/src/index.ts
import {
  activateTab,
  closeTab,
  closeWindow,
  evalJs,
  getActiveTab,
  getSource,
  getText,
  goBack,
  goForward,
  hardReload,
  isRunning,
  listWindows,
  navigate,
  newTab,
  newWindow,
  reload,
  screenshotTab,
} from "./chrome.ts";

const PORT = Number(Bun.env.PORT ?? 7880);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(v: string | null): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      if (path === "/health") {
        return json({ ok: true, running: await isRunning() });
      }

      if (path === "/windows" && method === "GET") {
        const wins = await listWindows();
        return json({ count: wins.length, windows: wins });
      }

      if (path === "/windows" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { url?: string; incognito?: boolean };
        const w = await newWindow({ url: body.url, incognito: body.incognito });
        return json({ ok: true, window: w });
      }

      const winMatch = path.match(/^\/windows\/(\d+)$/);
      if (winMatch && method === "DELETE") {
        await closeWindow(Number(winMatch[1]));
        return json({ ok: true });
      }

      if (path === "/tabs" && method === "GET") {
        const wins = await listWindows();
        const wid = num(url.searchParams.get("windowId"));
        const tabs = wid == null
          ? wins.flatMap((w) => w.tabs.map((t) => ({ ...t, windowId: w.id })))
          : (wins.find((w) => w.id === wid)?.tabs.map((t) => ({ ...t, windowId: wid })) ?? []);
        return json({ count: tabs.length, tabs });
      }

      if (path === "/tabs/active" && method === "GET") {
        const t = await getActiveTab();
        if (!t) return err(404, "no active tab");
        return json(t);
      }

      if (path === "/tabs" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; url?: string };
        const t = await newTab({ windowId: body.windowId, url: body.url });
        return json({ ok: true, tab: t });
      }

      const tabMatch = path.match(/^\/tabs\/(\d+)\/(\d+)$/);
      if (tabMatch && method === "DELETE") {
        await closeTab(Number(tabMatch[1]), Number(tabMatch[2]));
        return json({ ok: true });
      }

      if (path === "/navigate" && method === "POST") {
        const body = (await req.json()) as { url?: string; windowId?: number; tabIndex?: number };
        if (!body.url) return err(400, "missing 'url'");
        await navigate(body.url, body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/activate" && method === "POST") {
        const body = (await req.json()) as { windowId?: number; tabIndex?: number };
        if (body.windowId == null || body.tabIndex == null) {
          return err(400, "need {windowId, tabIndex}");
        }
        await activateTab(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/reload" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number; hard?: boolean };
        if (body.hard) {
          await hardReload(body.windowId, body.tabIndex);
        } else {
          await reload(body.windowId, body.tabIndex);
        }
        return json({ ok: true, hard: body.hard === true });
      }

      if (path === "/back" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number };
        await goBack(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/forward" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number };
        await goForward(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/eval" && method === "POST") {
        const body = (await req.json()) as { js?: string; windowId?: number; tabIndex?: number };
        if (!body.js) return err(400, "missing 'js'");
        const result = await evalJs(body.js, body.windowId, body.tabIndex);
        return json({ ok: true, result });
      }

      if (path === "/source" && method === "GET") {
        const wid = num(url.searchParams.get("windowId"));
        const tIdx = num(url.searchParams.get("tabIndex"));
        const html = await getSource(wid, tIdx);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (path === "/text" && method === "GET") {
        const wid = num(url.searchParams.get("windowId"));
        const tIdx = num(url.searchParams.get("tabIndex"));
        const text = await getText(wid, tIdx);
        return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      if (path === "/screenshot" && (method === "GET" || method === "POST")) {
        const opts = method === "POST"
          ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
          : {
              windowId: num(url.searchParams.get("windowId")),
              tabIndex: num(url.searchParams.get("tabIndex")),
              shadow: parseBool(url.searchParams.get("shadow")),
              delayMs: num(url.searchParams.get("delayMs")),
              format: (url.searchParams.get("format") === "json" ? "json" : "png") as "png" | "json",
              restore: parseBool(url.searchParams.get("restore")),
            };
        const result = await screenshotTab(opts as Parameters<typeof screenshotTab>[0]);
        return new Response(result.body, {
          headers: { "content-type": result.contentType, "cache-control": "no-store" },
        });
      }

      return err(404, `${method} ${path} not found`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(500, msg);
    }
  },
});

console.log(`@meta/chrome listening on http://localhost:${server.port}`);
console.log(`  GET  /health`);
console.log(`  GET  /windows                              list windows + tabs`);
console.log(`  POST /windows         { url?, incognito? } open new window`);
console.log(`  DEL  /windows/:id                          close window`);
console.log(`  GET  /tabs[?windowId=N]                    list tabs`);
console.log(`  GET  /tabs/active                          info on active tab`);
console.log(`  POST /tabs            { windowId?, url? }  open new tab`);
console.log(`  DEL  /tabs/:wid/:idx                       close tab`);
console.log(`  POST /navigate        { url, windowId?, tabIndex? }`);
console.log(`  POST /activate        { windowId, tabIndex }`);
console.log(`  POST /reload   { windowId?, tabIndex?, hard? }   hard=true → Cmd+Shift+R (steals focus)`);
console.log(`  POST /back | /forward   { windowId?, tabIndex? }`);
console.log(`  POST /eval            { js, windowId?, tabIndex? }   needs "Allow JS from Apple Events"`);
console.log(`  GET  /source[?windowId=N&tabIndex=N]       outerHTML of <html>`);
console.log(`  GET  /text[?windowId=N&tabIndex=N]         document.body.innerText`);
console.log(`  GET  /screenshot[?windowId=N&tabIndex=N&shadow=false&delayMs=200&format=png|json]`);
console.log(`  POST /screenshot { windowId?, tabIndex?, shadow?, delayMs?, format?, restore? }`);

```
