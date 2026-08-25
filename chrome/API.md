# @meta/chrome

Локальный REST-сервис для agent-driven управления Google Chrome через CDP.
AppleScript остаётся отдельным системным контуром для окон обычного Chrome, но
не участвует в адресации CDP-вкладок.

- База: `$CHROME_API` или `http://localhost:7880`.
- Основной идентификатор вкладки — стабильный `targetId` из `GET /cdp/targets`.
- `targetId` сохраняется при navigate/reload и исчезает только после закрытия target.
- JSON in / JSON out, кроме HTML/text, screenshot и trace responses.

## Запуск

```bash
cd /Users/zavx0z/repozitarium/ai-macos/chrome
bun run dev    # с hot reload
bun run start  # обычный запуск
bun run cdp    # Chrome с отдельным CDP-профилем
```

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `7880`).
- `CHROME_API` — база для CLI (по умолчанию `http://localhost:7880`).
- `CHROME_CDP_HOST` / `CHROME_CDP_PORT` — CDP endpoint (по умолчанию `localhost:9222`).

## Основной agent workflow

```bash
# 1. Получить точные targets. URL не используется как identity.
curl -s http://localhost:7880/cdp/targets

# 2. Либо создать отдельную вкладку сразу в CDP Chrome.
curl -s -X POST http://localhost:7880/cdp/targets \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:4214/"}'

# 3. Все дальнейшие операции адресовать по targetId.
curl -s -X POST http://localhost:7880/eval \
  -H 'content-type: application/json' \
  -d '{"targetId":"TARGET","js":"return {url:location.href,title:document.title}"}'
```

Один target не нужно повторно искать после навигации. Не смешивать CDP `targetId`,
AppleScript `windowId` и `tabIndex`: это идентификаторы разных контуров.

## CDP targets

### `GET /cdp/targets[?type=page|all]`

Возвращает безопасный inventory без `webSocketDebuggerUrl`:

```json
{
  "ok": true,
  "count": 1,
  "targets": [{
    "targetId": "92312DE4989B4D5CEAE84B49BC5B12C0",
    "type": "page",
    "title": "MetaFor Visual",
    "url": "http://127.0.0.1:4214/"
  }]
}
```

### `POST /cdp/targets`

Создаёт target в CDP Chrome и сразу возвращает `targetId`.

```json
{ "url": "http://127.0.0.1:4214/" }
```

### `POST /cdp/targets/:targetId/activate`

Активирует target без AppleScript.

### `DELETE /cdp/targets/:targetId`

Закрывает точный target.

## CDP diagnostics

### `POST /cdp/screenshot`

Снимает пиксели viewport напрямую через `Page.captureScreenshot`, без фокуса,
Screen Recording и Chrome UI. Для canvas/WebGPU это основной screenshot path.

```json
{
  "targetId": "TARGET",
  "format": "png",
  "fullPage": false,
  "waitReady": true,
  "waitOpts": {"reflowStable": false},
  "caption": "Ожидаю увидеть сцену MetaFor"
}
```

Ответ — `image/png`, `image/jpeg` или `image/webp`. Заголовки содержат
`x-meta-via: cdp` и `x-meta-target-id`.

### `POST /cdp/performance`

```json
{ "targetId": "TARGET" }
```

Возвращает `Performance.getMetrics`, DOM counters и page/viewport identity одним
компактным JSON snapshot.

### `POST /cdp/trace`

```json
{
  "targetId": "TARGET",
  "durationMs": 1000,
  "maxBytes": 50000000
}
```

Продолжительность ограничена 30 секундами, payload — 100 MB. Ответом приходит
необёрнутый browser-level DevTools trace JSON, пригодный для записи в файл и
загрузки в trace viewer. По умолчанию записываются все категории (`["*"]`): на
Chrome 150 узкие категории могут вернуть только metadata. `targetId` фиксирует
контекст запроса и гарантирует существование требуемой страницы, но сам trace
охватывает процессы CDP Chrome целиком.

### `POST /cdp/command`

One-shot escape hatch для CDP-метода, которого ещё нет в удобном REST endpoint:

```json
{
  "targetId": "TARGET",
  "method": "Runtime.getHeapUsage",
  "params": {},
  "timeoutMs": 10000
}
```

Session-bound и streaming workflows выполняются специализированными endpoints
(`/cdp/trace`), потому что one-shot session закрывается после ответа.

## Общие операции по targetId

Следующие существующие endpoints принимают `targetId` без `windowId/tabIndex`:

- `POST /navigate`
- `POST /reload`
- `POST /back`, `POST /forward`
- `POST /wait-ready`
- `POST /viewport`, `DELETE /viewport`
- `POST /eval`
- `GET|POST /console`
- `GET /source`, `GET /text`

Пример:

```json
{ "targetId": "TARGET", "url": "http://127.0.0.1:4204/", "waitReady": true }
```

## AppleScript/system UI

`GET /windows`, `/tabs`, `/activate` и обычный `/screenshot` обслуживают окна
macOS и Chrome UI. Они нужны, когда требуется физически показать окно или снять
панель вкладок. Для разработки страницы предпочтителен CDP-native API выше.

Когда одновременно работают обычный Chrome и отдельный CDP Chrome, AppleScript
не может выбрать точный профиль по PID. В этом состоянии все операции данного
раздела fail-closed с `409`: сервис не возвращает неполный `windows: []` и не
создаёт окно в произвольном профиле. Для CDP Chrome нужно получить существующий
`targetId` через `GET /cdp/targets` и продолжить через CDP-native endpoints.

AppleScript-автоматизация требует разрешения macOS. AppleScript fallback для
`/eval`, `/source`, `/text` дополнительно требует Chrome setting
**View → Developer → Allow JavaScript from Apple Events**.

## Эндпоинты

### `GET /health`

```json
{
  "ok": true,
  "running": true,
  "cdp": {"available": true, "browser": "Chrome/151.0.7922.76"},
  "browserProcesses": [
    {"pid": 564, "profile": "default", "remoteDebugging": false, "userDataDir": null},
    {"pid": 96181, "profile": "cdp", "remoteDebugging": true, "userDataDir": "/path/to/Chrome-CDP"}
  ],
  "appleScriptAmbiguous": true
}
```

### `GET /profiles`

Возвращает только безопасные метаданные доступных профилей Chrome — `directory` и отображаемое `name`. Email, GAIA ID и другие поля `Local State` наружу не выдаются.

### `POST /session`

Единый precondition перед browser-agent операциями:

- если Chrome уже запущен — возвращает `{"status":"ready","running":true,"launched":false}` и не перезапускает его;
- если Chrome закрыт и `profileDirectory` не передан — **ничего не запускает**, а возвращает `status: "choice_required"` и список `profiles`; вызывающая сторона должна спросить пользователя, какой профиль запускать;
- после явного выбора принимает `{"profileDirectory":"Profile 2"}` и запускает ровно этот профиль;
- неизвестный профиль даёт `400 status: "invalid_profile"`; автоматического fallback нет.

Даже если найден только один профиль, выбор остаётся обязательным. Обычный профиль запускается через `--profile-directory`; `--user-data-dir` и CDP-флаги здесь не используются. Специальная CDP-сессия `bun run cdp` остаётся отдельным механизмом.

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

| Поле           | По умолчанию | Что делает                                                                                                                   |
| -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `readyState`   | `true`       | дождаться `document.readyState === 'complete'`                                                                               |
| `fonts`        | `true`       | `await document.fonts.ready`                                                                                                 |
| `networkIdle`  | `true`       | нет inflight HTTP за `idleMs`. Счётчик ведётся снаружи через `Network.requestWillBeSent/loadingFinished/loadingFailed`       |
| `images`       | `true`       | принудительный `loading='eager'` + `Promise.all(load)` + `decode()` для всех `<img>`                                         |
| `reflowStable` | `true`       | дождаться двух подряд rAF, между которыми `documentElement.scrollWidth/scrollHeight` не изменились (internal deadline 2.5 с) |
| `animations`   | `true`       | дождаться завершения всех конечных `getAnimations()`                                                                         |
| `finalCommit`  | `true`       | финальный двойной rAF — коммит в композитор                                                                                  |
| `idleMs`       | `700`        | окно тишины network для шага `networkIdle`                                                                                   |
| `stepMs`       | `8000`       | таймаут одного шага (защита от зависшего шрифта/img)                                                                         |
| `maxMs`        | `15000`      | общий таймаут                                                                                                                |

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

В CDP-native path тело `js` выполняется в async wrapper, поэтому внутри можно
использовать `await`. Для точной адресации передавать `targetId`.

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
chrome profiles
chrome session [--profile <directory>]
chrome targets
chrome new-target      [--url <url>]
chrome activate-target --target <id>
chrome close-target    --target <id>
chrome navigate        --target <id> --url <url>
chrome reload          --target <id> [--hard]
chrome back            --target <id>
chrome forward         --target <id>
chrome eval            --target <id> --js "<code>"
chrome source          --target <id>
chrome text            --target <id>
chrome capture         --target <id> [--out <path>] [--full-page] [--caption <text>]
chrome performance     --target <id>
chrome trace           --target <id> [--duration <ms>] [--out <path>]
chrome command         --target <id> --method <Domain.method> [--params <json>]

# system UI / AppleScript
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
