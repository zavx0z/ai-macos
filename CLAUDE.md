# @meta/macos — правила для Claude Code

## Структура

Bun monorepo. Пять пакетов:

| Пакет | Порт | Назначение |
|---|---|---|
| `@meta/shared` | — | Общие утилиты: http, osa, params, log |
| `@meta/window` | 7878 | Управление окнами macOS через Accessibility API |
| `@meta/screen` | 7879 | Скриншоты через `screencapture` |
| `@meta/chrome` | 7880 | Управление десктопным Chrome через AppleScript |
| `@meta/android` | 7881 | Управление Chrome на Android через ADB + CDP |

Зависимости: `chrome` → `screen` → `window` → (system); `android` → adb + CDP.

## Запуск сервисов

```bash
cd /Users/vladimirfilipenko/meta/macos
bun run dev    # все сервисы параллельно (--hot)
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
curl -s http://localhost:7879/desktop -o /tmp/desktop.png
curl -s "http://localhost:7879/desktop?display=2" -o /tmp/d2.png       # второй дисплей
curl -s -X POST http://localhost:7879/desktop \
  -H 'content-type: application/json' \
  -d '{"display":1,"detail":"medium"}' -o /tmp/desktop.png

# Список захватываемых окон (прокси к window API)
curl "http://localhost:7879/windows"
curl "http://localhost:7879/windows?app=Google%20Chrome"

# Окно приложения
curl -s "http://localhost:7879/window?app=Google%20Chrome&detail=medium" -o /tmp/chrome.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&index=2" -o /tmp/chrome2.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&title=GitHub" -o /tmp/gh.png
# Параметры: app (обязательно), index (def 1), title (substring, приоритет над index),
#            restore (def true), delayMs (def 150, max 2000), shadow (def true),
#            detail (low|medium|high|full), scale (0.0..1.0), format (png|json)

curl -s -X POST http://localhost:7879/window \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","detail":"medium","shadow":false}' -o /tmp/chrome.png

# Область экрана (GET и POST принимают одинаковые параметры)
curl -s -X POST http://localhost:7879/rect \
  -H 'content-type: application/json' \
  -d '{"x":0,"y":0,"width":1920,"height":1200,"detail":"medium"}' -o /tmp/rect.png
```

Параметр `detail`:
| Значение | Масштаб | Размер |
|---|---|---|
| `low` | 25 % | ~200 КБ |
| `medium` | 50 % | ~400 КБ |
| `high` | 75 % | ~600 КБ |
| `full` | 100 % | ~900 КБ |

Формат `json` вместо `png` → `{ ok, target, mime, base64 }`.

## @meta/chrome — порт 7880

Health: `{ ok, running, cdp: { available, browser? } }` — `running: false` Chrome не запущен; `cdp.available: true` если Chrome поднят с `--remote-debugging-port=9222`.

**Гибридный режим:** если CDP доступен, `evalJs`/`navigate`/`reload` идут через CDP вместо AppleScript — без требования "Allow JavaScript from Apple Events" и без Automation. Иначе fallback на AppleScript. Ответы `/navigate` и `/reload` содержат поле `via: "cdp" | "applescript"`.

Запуск Chrome с CDP:
```bash
cd chrome && bun run cdp        # запускает отдельный Chrome с --remote-debugging-port=9222
cd chrome && bun run cdp:check  # проверка
# или: curl http://localhost:7880/cdp → { available: true, browser: "Chrome/..." }
```

Важно: Chrome 137+ блокирует `--remote-debugging-port` с дефолтным профилем. Скрипт `cdp` запускает **отдельный** экземпляр с `--user-data-dir=~/Library/Application Support/Google/Chrome-CDP` — основной Chrome пользователя не трогается. Это два независимых процесса; AppleScript увидит оба, но `tell application "Google Chrome"` обычно адресует тот, что был активен последним.

### Чтение console.log из вкладки

Когда CDP доступен:
```bash
# Слушать консоль 1500 мс — все console.* и Log.entryAdded (в т.ч. network errors)
curl -s -X POST http://localhost:7880/console \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2,"durationMs":1500}'
# → { ok, count, entries: [{ type, level: "log|info|warn|error|debug", text, url, line, timestamp }], via: "cdp" }
```
Если CDP недоступен — 503 с подсказкой `bun run cdp`.

```bash
# Окна
curl http://localhost:7880/windows
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

# Навигация
curl -X POST http://localhost:7880/navigate -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -X POST http://localhost:7880/activate -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'   # ← оба поля обязательны
# → { ok, windowId, tabIndex }   ← передай windowId в следующий /screenshot!
curl -X POST http://localhost:7880/reload -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'
# → { ok, hard, waited, waitMs }  — ждёт окончания загрузки по умолчанию
# hard: true → Cmd+Shift+R (сброс кеша, переносит фокус на Chrome)
# wait: false → вернуть немедленно без ожидания загрузки
curl -X POST http://localhost:7880/back
curl -X POST http://localhost:7880/forward

# Контент (требует View → Developer → Allow JavaScript from Apple Events)
curl -X POST http://localhost:7880/eval \
  -H 'content-type: application/json' -d '{"js":"return document.title"}'
# → { ok, result }
curl http://localhost:7880/source              # outerHTML (text/html)
curl http://localhost:7880/text                # innerText (text/plain)
curl "http://localhost:7880/source?windowId=12345&tabIndex=2"

# Скриншот — всегда передавать windowId и caption
# windowId берём из GET /windows или из ответа POST /activate
curl -s -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"detail":"medium","caption":"Ожидаю увидеть форму логина"}' -o /tmp/chrome.png
# Без windowId берётся первое окно Chrome — может быть не то!
```

## @meta/android — порт 7881

Управление Chrome на **Android-телефоне** через ADB + Chrome DevTools Protocol.

Требования: USB Debugging на телефоне, Chrome открыт хотя бы с одной вкладкой. **`adb` ставится автоматически** через `brew install --cask android-platform-tools` при старте сервиса (можно отключить переменной `ANDROID_AUTO_INSTALL=false`). При ошибках — `POST /bootstrap` пере-проверяет и пытается установить заново.

```bash
# Health: статус adb + список устройств + проверка CDP
curl http://localhost:7881/health
# ok:false если adb не установлен / телефон не подключён / Chrome не отвечает

# Список устройств
curl http://localhost:7881/devices
# → { devices: [{ serial, state }] }

# Пересоздать adb forward (на случай если телефон был отключён)
curl -X POST http://localhost:7881/forward

# Список вкладок Chrome на телефоне
curl http://localhost:7881/tabs
# → { tabs: [{ id, title, url, type }] }   id — стабильный CDP target ID

# Навигация / перезагрузка / eval — те же правила что у десктопа
curl -X POST http://localhost:7881/navigate \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","tabId":"ABC123"}'

curl -X POST http://localhost:7881/reload \
  -H 'content-type: application/json' \
  -d '{"tabId":"ABC123","wait":true}'
# По умолчанию ждёт document.readyState === "complete" (до 10 с)

curl -X POST http://localhost:7881/eval \
  -H 'content-type: application/json' \
  -d '{"js":"return navigator.userAgent","tabId":"ABC123"}'

# Скриншот вкладки — caption и detail работают так же
curl -s -X POST http://localhost:7881/screenshot \
  -H 'content-type: application/json' \
  -d '{"tabId":"ABC123","detail":"medium","caption":"Ожидаю мобильную версию формы логина"}' \
  -o phone.png
# fullPage:true → захват всей страницы (не только viewport)
```

Отличия от `@meta/chrome` (десктоп):
- Идентификатор вкладки — `tabId` (строка) вместо `windowId`+`tabIndex`
- Захват через CDP `Page.captureScreenshot` (только сама страница, без UI Chrome)
- `hard:true` в `/reload` = `ignoreCache:true` (без Cmd+Shift+R, фокус не перетаскивается)

## ⚠️ Скриншот Chrome — только через @meta/chrome

**НЕЛЬЗЯ** делать скриншот Chrome через `@meta/screen` (`/window` или `/rect` напрямую):
- `GET /window?app=Google%20Chrome` → вернёт 404 (нет Accessibility к Chrome окнам)
- `POST /window` → то же самое

**ПРАВИЛЬНО** — только через `@meta/chrome`:
```bash
curl -s -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"detail":"medium","caption":"Ожидаю увидеть главную страницу приложения"}' -o screenshot.png
```

`caption` — обязательно формулировать перед каждым скриншотом: одно предложение о том, что агент ожидает увидеть. После получения — сравнить ожидание с реальностью.

`@meta/chrome` сам:
1. Получает координаты окна через AppleScript (не нужна Accessibility)
2. Приводит нужное окно/вкладку на передний план
3. Вызывает `/rect` у `@meta/screen` с готовыми координатами
4. Масштабирует результат согласно `detail` / `scale`
5. Возвращает фокус предыдущему приложению

## Важные правила

- Никогда не использовать `osascript` / AppleScript / `screencapture` напрямую — только через REST API.
- Перед первой операцией вызвать `GET /health` нужного сервиса.
- При `granted: false` — вызвать `POST /permissions/*`, сообщить пользователю. **Не ретраить.**
- Имена приложений в `app` — каноническое имя процесса macOS (`"Google Chrome"`, не `"chrome"`).
- `windowId` в Chrome-сервисе — стабильный AppleScript ID из `GET /windows`, предпочтительнее `index`.
- **После `POST /reload` страница гарантированно загружена** (сервис ждёт `loading=false`, до 10 с) — скриншот сразу, без `sleep`.
- При ошибке `osascript failed (-1743)` — нет разрешения Automation.
- При ошибке `osascript failed (-25211)` — нет разрешения Accessibility.
