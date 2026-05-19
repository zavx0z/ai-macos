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
{ "url": "https://example.com", "windowId": 12345, "tabIndex": 2, "waitReady": true, "waitOpts": {} }
```

`waitReady: true` (по умолчанию) — после `Page.navigate` сервис ждёт полной готовности через `waitFullyReady`. Возвращает `{ ok, via, waitMs, ready }`. `waitReady: false` — поведение как было раньше, возврат сразу после `Page.navigate`.

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

`POST /reload` дополнительно принимает `{ "hard": true, "wait": true, "waitOpts": {...} }`. По умолчанию (`wait: true`) после перезагрузки сервис **ждёт полной готовности страницы** через `waitFullyReady` — см. `POST /wait-ready` ниже. Возвращает `{ ok, hard, waited, waitMs, via, ready }` где `ready` — детальный отчёт по шагам. `wait: false` → вернуться сразу после `Page.reload`. `waitOpts` пробрасывается в `waitFullyReady` (можно отключить отдельные шаги или поднять/опустить таймауты).

`hard: true` через CDP — это `Page.reload({ignoreCache: true})`, без отнятия фокуса. Без CDP — fallback на AppleScript+System Events с симуляцией `Cmd+Shift+R`, что **переносит фокус** на Chrome.

### `POST /wait-ready`

Дождаться, пока страница полностью прогрузится — `document.readyState === 'complete'`, шрифты загружены, network idle, все `<img>` (включая `loading="lazy"`) полностью загружены и декодированы, layout стабилизировался, все конечные CSS-анимации завершены, финальный двойной rAF.

```json
{ "windowId": 12345, "tabIndex": 2, "options": { /* see below */ } }
```

```json
{
  "via": "cdp",
  "ok": true,
  "reached": ["readyState","fonts","networkIdle","images","reflowStable","animations","finalCommit"],
  "skipped": [],
  "timedOut": false,
  "durationMs": 933,
  "steps": [
    { "name": "readyState", "ok": true, "durationMs": 2 },
    { "name": "fonts", "ok": true, "durationMs": 1 },
    { "name": "networkIdle", "ok": true, "durationMs": 715 },
    { "name": "images", "ok": true, "durationMs": 167 },
    { "name": "reflowStable", "ok": true, "durationMs": 15 },
    { "name": "animations", "ok": true, "durationMs": 1 },
    { "name": "finalCommit", "ok": true, "durationMs": 33 }
  ]
}
```

Опции `options` (все опциональные):

| Поле | По умолчанию | Что делает |
|---|---|---|
| `readyState` | `true` | дождаться `document.readyState === 'complete'` |
| `fonts` | `true` | `await document.fonts.ready` |
| `networkIdle` | `true` | нет inflight HTTP за `idleMs`. Счётчик ведётся снаружи через `Network.requestWillBeSent/loadingFinished/loadingFailed` |
| `images` | `true` | принудительный `loading='eager'` + `Promise.all(load)` + `decode()` для всех `<img>` |
| `reflowStable` | `true` | дождаться двух подряд rAF, между которыми `documentElement.scrollWidth/scrollHeight` не изменились (internal deadline 2.5 с) |
| `animations` | `true` | дождаться завершения всех конечных `getAnimations()` |
| `finalCommit` | `true` | финальный двойной rAF — коммит в композитор |
| `idleMs` | `700` | окно тишины network для шага `networkIdle` |
| `stepMs` | `8000` | таймаут одного шага (защита от зависшего шрифта/img) |
| `maxMs` | `15000` | общий таймаут |

Требует CDP (порт 9222). Без CDP — `503` с подсказкой запустить `bun run cdp`. Сервис сам вызывает `Emulation.setFocusEmulationEnabled` чтобы Chrome не тротлил `rAF`/`setTimeout` в фоновой вкладке (без отнятия OS-уровневого фокуса).

**После `Emulation.setDeviceMetricsOverride` через CDP — вызвать `/wait-ready` перед скриншотом**, иначе layout не успевает пересчитаться, lazy-картинки не подгружаются под новый viewport.

### `POST /viewport`

Изменить размер окна / viewport вкладки. Два режима плюс sizing-флаг:

- **`mode: "window"`** (по умолчанию для desktop) — физический ресайз окна Chrome через CDP `Browser.setWindowBounds`. То, что видит пользователь в браузере, совпадает с запрошенными `width`/`height`. Возвращает `bounds: { before, after }`.
- **`mode: "emulation"`** (автоматически при `mobile: true`) — виртуальный viewport через `Emulation.setDeviceMetricsOverride`. Физическое окно не меняется, страница видит запрошенные `width`/`height` плюс `deviceScaleFactor` и mobile-флаг (touch events, mobile UA, meta-viewport).
- **`innerSize: true`** (только с `mode: "window"`) — трактовать `width`/`height` как **content viewport** (`innerWidth × innerHeight`), а не outer-bounds окна. Сервис измеряет фактический `innerWidth/innerHeight` после первого resize и докручивает окно компенсируя Chrome UI (tab bar + address bar ≈ 80–90 px). Возвращает `inner: { width, height }` с фактическим content viewport.

```json
{ "windowId": 12345, "tabIndex": 2, "width": 1440, "height": 900, "mode": "window", "reload": true, "waitReady": true, "waitOpts": {} }
```

```json
{
  "ok": true, "via": "cdp",
  "applied": { "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": false, "mode": "window" },
  "bounds": { "before": { "width": 1280, "height": 800, ... }, "after": { "width": 1440, "height": 900, ... } },
  "reloaded": true,
  "ready": { "ok": true, "reached": [...], ... }
}
```

Оба режима по умолчанию **перезагружают страницу** (`Page.reload`) и запускают `waitFullyReady` — это критично для SPA/React-приложений, которые читают viewport один раз на mount и не реагируют на чистый `resize`-event без перезагрузки. `reload: false` оставляет страницу как есть (подходит для статики с обработчиком `resize`).

Window-mode требует, чтобы окно было в состоянии `"normal"` — если оно maximized/minimized, сервис сначала вернёт его в normal через `Browser.setWindowBounds({ windowState: "normal" })`.

### `DELETE /viewport`

Снимает emulation-override (`Emulation.clearDeviceMetricsOverride`) и (по умолчанию) делает reload + waitFullyReady.

```json
{ "windowId": 12345, "tabIndex": 2, "reload": true, "waitReady": true }
```

**Внимание:** DELETE НЕ возвращает physical resize (`mode: "window"`). Чтобы вернуть исходный размер окна — повторный `POST /viewport` с нужным размером, или `@meta/window /resize`.

### `POST /eval`

Выполнить JavaScript в контексте вкладки. JS оборачивается в IIFE, результат сериализуется через `JSON.stringify` и возвращается как `result` (всегда строка). Сервис дополнительно делает `JSON.parse(result)` и кладёт распарсенное значение в `parsed` — для объектов/массивов/чисел/булевых это удобнее чем парсить руками. Для не-JSON строк `parsed` будет `null`.

```json
{ "js": "return {iw:innerWidth, ih:innerHeight}", "windowId": 12345, "tabIndex": 2 }
```

```json
{ "ok": true, "result": "{\"iw\":1024,\"ih\":768}", "parsed": {"iw":1024,"ih":768} }
```

### `GET /source[?windowId=N&tabIndex=N]`

Возвращает `document.documentElement.outerHTML` как `text/html`.

### `GET /text[?windowId=N&tabIndex=N]`

Возвращает `document.body.innerText` как `text/plain`.

### `GET /screenshot[?windowId=N&tabIndex=N&shadow=false&delayMs=200&format=png|json]`

Скриншот окна Chrome, в котором лежит указанная вкладка. Если `tabIndex` задан и отличается от текущей активной, вкладка предварительно активируется. Запрос проксируется в `@meta/screen` (`POST /window`) с `app="Google Chrome"` и `title=` равным заголовку окна, поэтому для работы нужны живые `@meta/screen` и `@meta/window`.

`POST /screenshot` принимает то же тело JSON. На выходе — `image/png` (или JSON с base64 при `format=json`). Захватывается всё окно Chrome целиком (включая адресную строку и панель вкладок), а не только viewport.

Дополнительные поля:
- `waitReady` (boolean, default `true`) — перед захватом дождаться полной готовности страницы через `waitFullyReady` (если CDP доступен). Отключить через `waitReady: false` или `?waitReady=false` если страница динамическая и заведомо не «успокоится».
- `waitOpts` (object, body-only) — параметры `waitFullyReady` (см. `POST /wait-ready`).

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
