# @meta/macos — правила для AI-агентов

## Структура

Bun monorepo. Пять пакетов:

| Пакет           | Порт | Назначение                                                      |
| --------------- | ---- | --------------------------------------------------------------- |
| `@meta/shared`  | —    | Общие утилиты                                                   |
| `@meta/window`  | 7878 | Окна macOS (Accessibility)                                      |
| `@meta/screen`  | 7879 | Скриншоты (`screencapture`)                                     |
| `@meta/chrome`  | 7880 | Десктопный Chrome (CDP-native agent API + системные окна macOS) |
| `@meta/android` | 7881 | Chrome на Android (ADB + CDP)                                   |
| `@meta/input`   | 7882 | Клавиатура, мышь и clipboard (native CoreGraphics + pbpaste/pbcopy) |

## Запуск сервисов

```bash
cd /Users/vladimirfilipenko/meta/macos
bun run dev      # все сервисы параллельно с --hot
```

## Разрешения macOS

Каждый сервис проверяет и **сам открывает** нужный раздел System Settings.

```bash
# Accessibility — нужно для window: move/resize/arrange/list/raise/pin
curl http://localhost:7878/permissions/accessibility          # GET: { granted: true|false }
curl -X POST http://localhost:7878/permissions/accessibility  # POST: { granted, opened: true }

# Screen Recording — нужно для screen: все скриншоты
curl http://localhost:7879/permissions/screen-recording
curl -X POST http://localhost:7879/permissions/screen-recording
```

При `granted: false` → вызвать `POST /permissions/*`, сообщить пользователю. **Не ретраить операцию.**

## @meta/window — порт 7878

```bash
# Размер экрана (логические пиксели)
curl http://localhost:7878/screen
# → { width: 1920, height: 1200 }

# Список видимых окон
curl "http://localhost:7878/windows"
curl "http://localhost:7878/windows?app=Google%20Chrome"
# → { count: N, windows: [{ app, pid, index, title, x, y, width, height }] }

# Фокус (не требует Accessibility)
curl -X POST http://localhost:7878/focus \
  -H 'content-type: application/json' -d '{"app":"Google Chrome"}'

# Переместить / изменить размер
curl -X POST http://localhost:7878/move   -H 'content-type: application/json' -d '{"app":"iTerm2","x":960,"y":600}'
curl -X POST http://localhost:7878/resize -H 'content-type: application/json' -d '{"app":"iTerm2","width":960,"height":600}'

# Расположить по пресету → { ok, applied: { x, y, width, height } }
curl -X POST http://localhost:7878/arrange \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","preset":"left"}'
# Пресеты: left | right | top | bottom | max | center

# Поднять окно поверх без отнятия фокуса (AXRaise, одноразово)
curl -X POST http://localhost:7878/raise \
  -H 'content-type: application/json' -d '{"app":"iTerm2","index":1}'

# Soft "always on top" — цикл AXRaise каждые intervalMs мс (min 100)
curl -X POST http://localhost:7878/pin \
  -H 'content-type: application/json' -d '{"app":"iTerm2","intervalMs":500}'
# → { ok, pin: { id, app, index, intervalMs, startedAt, raises, errors } }

curl -X DELETE http://localhost:7878/pin/1   # снять один
curl -X DELETE http://localhost:7878/pin     # снять все
curl http://localhost:7878/pin               # список активных
```

### ⚠️ Ограничения /raise и /pin

- `AXRaise` **не пробивает** поверх активного окна другого приложения при клике.
- Для настоящего «always on top» нужна **iTerm hotkey floating window** (Settings → Keys → Hotkey → Floating Window ✅).
- PiP-окна браузеров не пробить AXRaise.
- Pin-циклы сбрасываются при перезапуске сервера.

## @meta/screen — порт 7879

Health возвращает состояние самого сервиса и доступность window API:
```json
{ "ok": true, "windowApi": "http://localhost:7878", "window": { "ok": true } }
```

```bash
# Рабочий стол
curl -s http://localhost:7879/desktop -o desktop.png
curl -s "http://localhost:7879/desktop?display=2" -o d2.png       # второй дисплей
curl -s -X POST http://localhost:7879/desktop \
  -H 'content-type: application/json' \
  -d '{"display":1,"detail":"medium"}' -o desktop.png

# Список захватываемых окон (прокси к window API)
curl "http://localhost:7879/windows"
curl "http://localhost:7879/windows?app=Google%20Chrome"

# Окно приложения
curl -s "http://localhost:7879/window?app=Google%20Chrome&detail=medium" -o chrome.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&index=2" -o chrome2.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&title=GitHub" -o gh.png
# Параметры: app (обязательно), index (def 1), title (substring, приоритет над index),
#            restore (def true), delayMs (def 150, max 2000), shadow (def true),
#            detail (low|medium|high|full), scale (0.0..1.0), format (png|json)

curl -s -X POST http://localhost:7879/window \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","detail":"medium","shadow":false}' -o chrome.png

# Область экрана (GET и POST принимают одинаковые параметры)
curl -s -X POST http://localhost:7879/rect \
  -H 'content-type: application/json' \
  -d '{"x":0,"y":0,"width":1920,"height":1200,"detail":"medium"}' -o rect.png
```

Параметр `detail`:
| Значение | Масштаб | Размер  |
| -------- | ------- | ------- |
| `low`    | 25 %    | ~200 КБ |
| `medium` | 50 %    | ~400 КБ |
| `high`   | 75 %    | ~600 КБ |
| `full`   | 100 %   | ~900 КБ |

Формат `json` вместо `png` → `{ ok, target, mime, base64 }`.

## @meta/chrome — порт 7880

Health: `{ ok, running, cdp }` — `running: false` Chrome не запущен; `cdp.available: true` если Chrome запущен с `--remote-debugging-port=9222`.

**Основной агентский контракт — CDP `targetId`.** Сначала вызвать
`GET /cdp/targets`, затем передавать выбранный `targetId` в `/navigate`,
`/reload`, `/wait-ready`, `/viewport`, `/eval`, `/console`, `/source` и `/text`.
`targetId` сохраняется при navigate/reload. Не связывать CDP-вкладки с
AppleScript-окнами по URL: отдельный CDP-профиль и обычный Chrome имеют разные
window identity даже при одинаковом URL и геометрии.

`windowId/tabIndex` относятся к системному AppleScript-контуру и нужны только
для физического окна/Chrome UI. Без `targetId` часть старых операций может
использовать AppleScript fallback, но это не основной путь разработки.

Если одновременно запущены обычный Chrome и отдельный CDP Chrome, macOS
AppleScript не умеет адресовать профиль по PID. Поэтому `/windows`, `/tabs` и
изменяющие AppleScript-операции отвечают `409`, а не возвращают неполный список
и не выбирают произвольный профиль. В этом состоянии использовать только
`GET /cdp/targets` и точный `targetId`; нельзя трактовать прежнее `windows: []`
как отсутствие уже открытого CDP target и нельзя вызывать `POST /windows`.

Чтобы поднять Chrome с CDP:
```bash
cd chrome && bun run cdp          # запускает отдельный Chrome (отдельный профиль)
cd chrome && bun run cdp:check    # проверка
# или: curl http://localhost:7880/cdp → { available: true, browser: "Chrome/..." }
```

Chrome 137+ запрещает `--remote-debugging-port` на дефолтном профиле, поэтому скрипт открывает экземпляр с `--user-data-dir=~/Library/Application Support/Google/Chrome-CDP` — это **отдельный** Chrome рядом с основным.

```bash
# Stable target inventory без debugger WebSocket URL
curl http://localhost:7880/cdp/targets

# Создать target сразу в CDP Chrome
curl -X POST http://localhost:7880/cdp/targets \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:4214/"}'

# Прямой viewport screenshot без фокуса и Chrome UI
curl -s -X POST http://localhost:7880/cdp/screenshot \
  -H 'content-type: application/json' \
  -d '{"targetId":"TARGET","format":"png","caption":"Ожидаю увидеть visual scene"}' \
  -o visual.png

# Диагностика
curl -X POST http://localhost:7880/cdp/performance -d '{"targetId":"TARGET"}'
curl -X POST http://localhost:7880/cdp/trace -d '{"targetId":"TARGET","durationMs":1000}' -o trace.json
curl -X POST http://localhost:7880/cdp/command \
  -d '{"targetId":"TARGET","method":"Runtime.getHeapUsage","params":{}}'
```

`GET /windows` возвращает смешанный список Chrome-окон:

- `kind:"browser"` — обычное окно Chrome с массивом `tabs`; только такие окна можно использовать для операций с вкладками (`/tabs`, `/activate`, `/navigate`, `/reload`, `/eval`, `/source`, `/text`, `/viewport`, `/console`, `/wait-ready`).
- `kind:"appWindow"` — Chrome app-mode окно, найденное по процессу `Google Chrome --app=<url>`; у него есть `id`, `title`, `url`, `pid`, геометрия и `tabs: []`. Не подставлять его в tab-операции и не выдумывать `tabIndex`.

### Чтение консоли через CDP

```bash
# Прослушать консоль вкладки 1500 мс
curl -s -X POST http://localhost:7880/console \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"durationMs":1500}'
# → { entries: [{ type, level: "log|info|warn|error|debug", text, url, line, timestamp }], via: "cdp" }
```
Захватываются `console.log/info/warn/error/debug` + `Log.entryAdded` (network errors, browser warnings). Без CDP → 503 с подсказкой `bun run cdp`.

```bash
# Окна
curl http://localhost:7880/windows
# → windows: [{ kind:"browser", tabs:[...] }, { kind:"appWindow", url, pid, tabs:[] }]
curl -X POST http://localhost:7880/windows \
  -H 'content-type: application/json' -d '{"url":"https://example.com","incognito":false}'
curl -X DELETE http://localhost:7880/windows/12345

# Вкладки
curl http://localhost:7880/tabs
curl "http://localhost:7880/tabs?windowId=12345"
curl http://localhost:7880/tabs/active
curl -X POST http://localhost:7880/tabs \
  -H 'content-type: application/json' -d '{"windowId":12345,"url":"https://example.com"}'
curl -X DELETE http://localhost:7880/tabs/12345/2   # /tabs/:windowId/:index

# Навигация — по умолчанию waitReady:true (ждём полной готовности через waitFullyReady)
curl -X POST http://localhost:7880/navigate -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"url":"https://example.com"}'
# Старое поведение (без wait):
curl -X POST http://localhost:7880/navigate -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"url":"https://example.com","waitReady":false}'
curl -X POST http://localhost:7880/activate -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'   # ← оба поля обязательны
# → { ok, windowId, tabIndex }   ← сохрани windowId для следующего /screenshot!
curl -X POST http://localhost:7880/reload -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'
# → { ok, hard, waited, waitMs, via, ready }
# wait:true (по умолчанию) → после Page.reload запускает waitFullyReady (полная готовность)
# hard:true → CDP Page.reload({ignoreCache:true}) — без отнятия фокуса
#             AppleScript-фоллбек: Cmd+Shift+R через System Events — отнимает фокус
# wait:false → вернуть немедленно
# waitOpts: пробрасывается в waitFullyReady
curl -X POST http://localhost:7880/back
curl -X POST http://localhost:7880/forward

# Контент (требует View → Developer → Allow JavaScript from Apple Events)
curl -X POST http://localhost:7880/eval \
  -H 'content-type: application/json' -d '{"js":"return document.title"}'
# → { ok, result: "...", parsed: ... }
# result — всегда строка (JSON.stringify результата JS). parsed — JSON.parse(result)
# для объектов/массивов/чисел/булевых, null для не-JSON строк.
curl http://localhost:7880/source              # outerHTML (text/html)
curl http://localhost:7880/text                # innerText (text/plain)
curl "http://localhost:7880/source?windowId=12345&tabIndex=2"

# Скриншот — всегда передавать windowId (из /windows или из ответа /activate) и caption
curl -s -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"detail":"medium","caption":"Ожидаю увидеть главную страницу с навигацией"}' -o chrome.png
# Без windowId берётся первое окно Chrome — может быть не то!
# caption логируется до захвата, возвращается в x-meta-caption заголовке
```

### /wait-ready и /viewport (CDP only)

```bash
# Полная готовность страницы: readyState, fonts, networkIdle, eager-load всех <img>,
# reflowStable, animations, finalCommit. Каждый шаг — отдельный stepMs, общий maxMs.
curl -X POST http://localhost:7880/wait-ready -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'
# → { via:"cdp", ok, reached:[...], skipped:[...], timedOut, durationMs, steps:[...] }
# options: { readyState?, fonts?, networkIdle?, images?, reflowStable?, animations?,
#            finalCommit?, idleMs?(700), stepMs?(8000), maxMs?(15000) }
# Для страниц с бесконечной rAF-анимацией: { "options": { "reflowStable": false } }

# Resize окна Chrome — физический ресайз через Browser.setWindowBounds (mode:"window", default)
curl -X POST http://localhost:7880/viewport -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"width":1440,"height":900}'
# → { ok, applied:{...,mode:"window",innerSize:false}, bounds:{before,after}, inner:{...}, reloaded:true, ready:{...} }

# Точный content viewport — innerSize:true. Сервис компенсирует Chrome UI (~80-90px высоты).
curl -X POST http://localhost:7880/viewport -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"width":1024,"height":768,"innerSize":true}'
# → applied.innerSize:true, inner:{width:1024,height:768}, bounds.after.height ≈ 855

# Mobile-эмуляция — виртуальный viewport (mode:"emulation"; авто при mobile:true)
curl -X POST http://localhost:7880/viewport -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
# Физическое окно НЕ меняется — страница видит виртуальный viewport, есть touch + mobile UA.

# По умолчанию reload:true → после resize страница перезагружается + waitFullyReady.
# reload:false — оставить страницу как есть (для статики с resize-listener).

# DELETE снимает emulation-override (но не возвращает physical resize — для него надо
# повторно POST /viewport или @meta/window /resize):
curl -X DELETE http://localhost:7880/viewport -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'
```

`POST /screenshot` теперь по умолчанию дёргает waitFullyReady перед захватом — `waitReady:true`. Отключить: `{"waitReady":false}` в body или `?waitReady=false` в query.

Сервис вызывает `Emulation.setFocusEmulationEnabled` чтобы Chrome не тротлил rAF/setTimeout в фоновых вкладках — wait работает даже когда окно Chrome не в фокусе.

### CDP-ловушки (если работаешь с CDP напрямую, минуя сервис)

Сервис всё это уже учитывает — этот блок для случаев когда агент сам открывает WS к 9222.

- **`Emulation.clearDeviceMetricsOverride` в одиночку ненадёжен.** Chrome может «восстановить» предыдущий override после закрытия CDP-сессии — встречалось при переключении с mobile-emulation на physical resize: одиночный `clear` отвечает `{}` ok, но следующая сессия снова видит `innerWidth=390`. Надёжная последовательность: `clear → setDeviceMetricsOverride({width:0,height:0,deviceScaleFactor:0,mobile:false}) → clear`. В коде сервиса это `forceClearMetrics()` (chrome/src/cdp-mode.ts), вызывается в `mode:"window"` и в `DELETE /viewport`.
- **`Runtime.evaluate` зависает сразу после `Page.reload`/`Page.navigate`.** Старый Runtime context разрушен, новый ещё не создан — вызов висит в pending бесконечно. Перед evaluate подпишись на `Page.loadEventFired` (или `Page.frameStoppedLoading`) с fallback-таймаутом. В сервисе — `waitForLoadEvent()`.
- **`window.addEventListener("load", …, {once:true})` после уже-firеd события не сработает.** Не строй ожидание на нём. Polling `document.readyState === "complete"` — надёжнее (`setTimeout` ок, если вкладка не тротлится).
- **Тротлинг фоновых вкладок:** rAF падает до ~1 Hz, минимальный `setTimeout` — до ~1000 мс в неактивных вкладках. Любой wait-loop на них зависает. В начале сессии: `Emulation.setFocusEmulationEnabled({enabled:true})` — рендерер думает что страница в фокусе, тротлинг выключен, OS-фокус не трогается.
- **`Browser.setWindowBounds` ругается на width/height при `windowState:"maximized"` или `"minimized"`.** Сначала `setWindowBounds({windowState:"normal"})`, потом размер вторым вызовом.
- **CDP-override живёт на target, не на сессии.** Закрытие WS не откатывает override автоматически. Что установил — то и сними явно, желательно в той же сессии.

## @meta/android — порт 7881

Chrome на Android-телефоне через ADB + CDP. **`adb` устанавливается автоматически** на старте сервиса (через `brew install --cask android-platform-tools`). От пользователя нужно: USB Debugging на телефоне, кабель, открытый Chrome. `ANDROID_AUTO_INSTALL=false` отключает авто-установку.

> ⚠️ ADB forward использует порт **9223** (не 9222). Порт 9222 зарезервирован под десктопный Chrome CDP. Если сервис возвращает корректный `browser` в `/health`, но скриншоты/вкладки выглядят как с маковского Chrome — порты конфликтуют, нужен `POST /bootstrap`.

```bash
# Проверка состояния
curl http://localhost:7881/health
# → { ok, adb, devices, browser?, hint? }

curl http://localhost:7881/devices
# → { devices: [{ serial, state }] }

curl -X POST http://localhost:7881/forward      # пересоздать adb forward
curl -X POST http://localhost:7881/bootstrap    # пере-проверить всё + автоустановка adb

# Список вкладок (CDP target ID — стабильный)
curl http://localhost:7881/tabs
# → { tabs: [{ id, title, url, type }] }

curl -X POST http://localhost:7881/navigate -H 'content-type: application/json' \
  -d '{"url":"https://example.com","tabId":"ABC"}'

curl -X POST http://localhost:7881/reload -H 'content-type: application/json' \
  -d '{"tabId":"ABC","wait":true}'   # ждёт document.readyState === complete

curl -X POST http://localhost:7881/eval -H 'content-type: application/json' \
  -d '{"js":"return navigator.userAgent","tabId":"ABC"}'

curl http://localhost:7881/source            # outerHTML
curl http://localhost:7881/text              # innerText

# Скриншот — caption и detail обязательны как и везде
curl -s -X POST http://localhost:7881/screenshot \
  -H 'content-type: application/json' \
  -d '{"tabId":"ABC","detail":"medium","caption":"Ожидаю мобильную форму логина","fullPage":false}' \
  -o phone.png
# fullPage:true → захват всей страницы (не только viewport)
# CDP снимает только содержимое страницы — без UI Chrome (адресной строки, табов)
```

## @meta/input — порт 7882

Клавиатура и мышь. HTTP API и вся логика реализованы на **Bun + TypeScript**. Единственный backend ввода — собираемый локально `input/bin/meta-input-helper`, который вызывает официальные CoreGraphics/Accessibility API. Python, `cliclick` и AppleScript не используются. Нужно один раз выдать **Accessibility** именно `meta-input-helper`; при отсутствии разрешения API закрывается с `503` и не сообщает ложный успех.

```bash
curl http://localhost:7882/health
# → { ok, backend:"native-helper", helper, accessibility, hint? }
# ok: true = helper собран И тестовое CoreGraphics-событие фактически прошло

curl -X POST http://localhost:7882/permissions/accessibility
# регистрирует запрос TCC и открывает System Settings

# Мышь
curl http://localhost:7882/mouse/position                       # { x, y }
curl -X POST http://localhost:7882/mouse/move    -d '{"x":500,"y":400}'
curl -X POST http://localhost:7882/mouse/click   -d '{"x":500,"y":400,"button":"left","count":2}'
curl -X POST http://localhost:7882/mouse/drag    -d '{"from":{"x":100,"y":100},"to":{"x":300,"y":300}}'
curl -X POST http://localhost:7882/mouse/scroll  -d '{"dy":3}'

# Клавиатура
curl -X POST http://localhost:7882/keyboard/type     -d '{"text":"Hello","delayMs":30}'
curl -X POST http://localhost:7882/keyboard/key      -d '{"key":"enter"}'
curl -X POST http://localhost:7882/keyboard/key      -d '{"key":"a","modifiers":["cmd","shift"]}'
curl -X POST http://localhost:7882/keyboard/shortcut -d '{"shortcut":"cmd+shift+t"}'
curl -X POST http://localhost:7882/keyboard/shortcut -d '{"sequence":["cmd+a","cmd+c"],"delayMs":80}'
```

Имена клавиш: `enter|return`, `tab`, `space`, `escape|esc`, `delete|backspace`, `forwarddelete`, `left|right|up|down`, `home`, `end`, `pageup`, `pagedown`, `f1..f20`, или одиночный символ.
Модификаторы: `cmd|command|meta|⌘`, `shift|⇧`, `alt|option|opt|⌥`, `ctrl|control|⌃`, `fn`.

### Системный clipboard

Clipboard работает напрямую через системные `/usr/bin/pbpaste` и `/usr/bin/pbcopy`, не требует Accessibility и не использует UI-эмуляцию `Cmd+C`/`Cmd+V`.

```bash
curl http://localhost:7882/clipboard
curl -X POST http://localhost:7882/clipboard \
  -H 'content-type: application/json' -d '{"text":"Hello from ai-macos"}'
```

`GET /health` возвращает отдельный объект `clipboard` с backend и состоянием доступности обеих системных команд.

## Правила для агентов

1. **Перед каждым скриншотом** — сформулировать одним предложением, что ожидается увидеть, и передать это в поле `caption`. После получения изображения — сравнить ожидание с реальностью и сообщить о расхождении.
2. Перед первой операцией с сервисом вызвать `GET /health`. Для `@meta/input` это активная проба события, а не только TCC preflight. При ошибке — сообщить пользователю, не ретраить.
3. При `granted: false` от `/permissions/*` — вызвать `POST /permissions/*` (откроет Settings), сообщить пользователю, не ретраить.
4. Для скриншотов передавать `detail="medium"` если пользователь не указал иное.
5. Использовать только REST API — никакого прямого `osascript`, `screencapture` или AppleScript.
6. Имя приложения (`app`) — каноническое имя процесса macOS, строго по системному.
7. Для разработки страницы сначала вызвать `GET /cdp/targets`, выбрать точный `targetId` и использовать его во всех дальнейших CDP-операциях. Не полагаться на URL как identity. `GET /windows` использовать только для системного окна/Chrome UI.
8. Для screenshot страницы/canvas использовать `POST /cdp/screenshot {targetId,...}`: он снимает compositor напрямую, не требует фокуса или `@meta/screen`. Обычный `POST /screenshot {windowId,tabIndex,...}` нужен только когда в кадре требуется сам Chrome UI.
9. Окна `kind:"appWindow"` из `GET /windows` — это Chrome app-mode (`Google Chrome --app=<url>`). Они нужны для видимости/диагностики Chrome app окон, но не имеют вкладок; не использовать их с `/activate`, `/navigate`, `/reload`, `/eval`, `/source`, `/text`, `/viewport`, `/console`, `/wait-ready` и не придумывать `tabIndex`.
10. После `POST /reload` страница гарантированно загружена (сервис ждёт до 10 с) — можно сразу делать скриншот без `sleep`. `hard: true` переносит фокус на Chrome — использовать только если пользователь явно просит сбросить кеш.
11. `/activate` требует оба поля `windowId` и `tabIndex` — без них вернёт 400.
12. При ошибке `osascript failed (-1743)` — нет разрешения Automation.
13. При `503` от `@meta/input` — нет разрешения Accessibility для пути из `/health.helper`; вызвать `POST /permissions/accessibility`, сообщить пользователю и не ретраить.
14. **Canvas/WebGPU-приложения:** основной proof — `POST /cdp/screenshot` после `/wait-ready`. Если нужен ровно один canvas без остального viewport, использовать `POST /eval {targetId,js:"return document.querySelector('canvas').toDataURL('image/png')"}` и декодировать data URL. При нескольких canvas выбирать точный индекс.


## Ветки Git и рабочие каталоги

- Агент работает в том каноническом каталоге и в той ветке Git, где начата
  задача. Текущая ветка является веткой выполнения задачи.
- Без прямого указания пользователя нельзя создавать, подключать, переключать,
  переименовывать или удалять ветки Git, дополнительные рабочие каталоги Git и
  копии репозитория.
- Аудит, параллельная работа, изоляция задачи, наличие чужих изменений и
  временный каталог, созданный средой агента, не являются разрешением на новое
  ответвление. Если продолжать в текущем состоянии нельзя, агент
  останавливается и сообщает пользователю точную причину.
- Слияние, перенос отдельных коммитов, изменение основания, принудительный
  сброс и отправка изменений на сервер выполняются только по отдельному прямому
  указанию пользователя.
