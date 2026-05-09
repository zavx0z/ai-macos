# @meta/macos — правила для AI-агентов

## Структура монорепо

Bun workspaces. Пакеты: `shared`, `window`, `screen`, `chrome`.

Зависимости (runtime): `chrome` → `screen` → `window`.

## REST-сервисы

| Сервис | Порт | Назначение |
|---|---|---|
| `@meta/window` | 7878 | Окна macOS (Accessibility API) |
| `@meta/screen` | 7879 | Скриншоты (`screencapture` + `sips`) |
| `@meta/chrome` | 7880 | Google Chrome (AppleScript) |

## Разрешения macOS

Каждый сервис проверяет и **сам открывает** нужный раздел System Settings.

```bash
# Accessibility — нужно для window: move/resize/arrange/list/raise/pin
curl http://localhost:7878/permissions/accessibility          # GET: { granted: true|false }
curl -X POST http://localhost:7878/permissions/accessibility  # POST: проверить + открыть Settings

# Screen Recording — нужно для screen: все скриншоты
curl http://localhost:7879/permissions/screen-recording
curl -X POST http://localhost:7879/permissions/screen-recording
```

При `granted: false` → вызвать `POST /permissions/*`, сообщить пользователю. **Не ретраить операцию.**

## Скриншоты

Параметр `detail` задаёт уровень детализации:

- `"low"` → 25 % от Retina-разрешения (~200 КБ)
- `"medium"` → 50 % (~400 КБ) — **рекомендуется для vision-моделей**
- `"high"` → 75 % (~600 КБ)
- `"full"` → 100 % оригинал (~900 КБ)

Альтернатива — числовой `scale` от 0.0 до 1.0.

Health возвращает состояние сервиса и доступность window API:
```json
{ "ok": true, "windowApi": "http://localhost:7878", "window": { "ok": true } }
```

### Скриншот рабочего стола

```bash
curl -s http://localhost:7879/desktop -o screenshot.png
curl -s "http://localhost:7879/desktop?display=2" -o display2.png
curl -s -X POST http://localhost:7879/desktop \
  -H 'content-type: application/json' \
  -d '{"display":1,"detail":"medium"}' -o screenshot.png
```

### Список захватываемых окон (прокси к window API)

```bash
curl http://localhost:7879/windows
curl "http://localhost:7879/windows?app=Google%20Chrome"
```

### Скриншот окна приложения

```bash
curl -s "http://localhost:7879/window?app=Google%20Chrome&detail=medium" -o chrome.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&index=2" -o chrome2.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&title=GitHub" -o github.png
```

Параметры: `app` (обязательно), `index` (default 1), `title` (substring, приоритет над index),
`restore` (default true), `delayMs` (default 150), `shadow` (default true).

### Скриншот области экрана

```bash
curl -s -X POST http://localhost:7879/rect \
  -H 'content-type: application/json' \
  -d '{"x":0,"y":0,"width":1920,"height":1200,"detail":"medium"}' -o rect.png
```

### Скриншот вкладки Chrome

```bash
curl -s http://localhost:7880/screenshot -o chrome.png
curl -s -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"detail":"medium"}' -o chrome.png
```

## Управление Chrome

```bash
# Окна и вкладки
curl http://localhost:7880/windows
curl -X POST http://localhost:7880/windows -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -X DELETE http://localhost:7880/windows/<id>
curl http://localhost:7880/tabs
curl "http://localhost:7880/tabs?windowId=12345"
curl http://localhost:7880/tabs/active
curl -X POST http://localhost:7880/tabs -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -X DELETE http://localhost:7880/tabs/<windowId>/<index>

# Навигация
curl -X POST http://localhost:7880/navigate  -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -X POST http://localhost:7880/activate  -H 'content-type: application/json' -d '{"windowId":12345,"tabIndex":2}'  # оба поля обязательны
curl -X POST http://localhost:7880/reload
curl -X POST http://localhost:7880/reload    -H 'content-type: application/json' -d '{"hard":true}'  # cache bypass, уводит фокус
curl -X POST http://localhost:7880/back
curl -X POST http://localhost:7880/forward

# Контент (требует Allow JavaScript from Apple Events в Chrome)
curl -X POST http://localhost:7880/eval -H 'content-type: application/json' -d '{"js":"return document.title"}'
curl http://localhost:7880/source   # outerHTML
curl http://localhost:7880/text     # innerText
```

## Управление окнами

```bash
# Размер экрана (логические пиксели)
curl http://localhost:7878/screen
# → { width: 1920, height: 1200 }

# Список видимых окон
curl http://localhost:7878/windows
curl "http://localhost:7878/windows?app=Google%20Chrome"
# → { count: N, windows: [{ app, pid, index, title, x, y, width, height }] }

# Расположить по пресету (left|right|top|bottom|max|center)
curl -X POST http://localhost:7878/arrange \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","preset":"right"}'

# Переместить / изменить размер
curl -X POST http://localhost:7878/move   -H 'content-type: application/json' -d '{"app":"iTerm2","x":960,"y":600}'
curl -X POST http://localhost:7878/resize -H 'content-type: application/json' -d '{"app":"iTerm2","width":960,"height":600}'

# Фокус (не требует Accessibility)
curl -X POST http://localhost:7878/focus \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome"}'

# Поднять окно поверх без отнятия фокуса (одноразово)
curl -X POST http://localhost:7878/raise \
  -H 'content-type: application/json' \
  -d '{"app":"iTerm2","index":1}'

# Soft "always on top" — фоновый цикл AXRaise
curl -X POST http://localhost:7878/pin \
  -H 'content-type: application/json' \
  -d '{"app":"iTerm2","intervalMs":500}'
# → { pin: { id: "1", raises: N, errors: N } }
curl -X DELETE http://localhost:7878/pin/1   # снять один
curl -X DELETE http://localhost:7878/pin     # снять все
curl http://localhost:7878/pin               # список активных
```

> `/raise` и `/pin` используют `AXRaise` — не настоящий NSWindow topmost.
> При клике в другое приложение окно уйдёт вниз.
> Для реального «всегда поверх» в iTerm2: Settings → Keys → Hotkey → **Floating Window ✅**.
> PiP-окна браузеров не пробить никаким AXRaise.

## Правила для агентов

1. Перед первой операцией с сервисом вызвать `GET /health`. При ошибке — сообщить пользователю, не ретраить.
2. При `granted: false` от `/permissions/*` — вызвать `POST /permissions/*` (откроет Settings), сообщить пользователю, не ретраить.
3. Для скриншотов передавать `detail="medium"` если пользователь не указал иное.
4. Использовать только REST API — никакого прямого `osascript`, `screencapture` или AppleScript.
5. Имя приложения (`app`) — каноническое имя процесса macOS, строго по системному.
6. `windowId` в Chrome-сервисе — стабильный AppleScript ID из `GET /windows`, предпочтительнее `index`.
7. Для скриншота Chrome использовать `GET /screenshot` или `POST /screenshot` у `@meta/chrome`, не напрямую `@meta/screen`.
8. `hard: true` в `/reload` переносит фокус на Chrome — использовать только если пользователь явно просит сбросить кеш.
9. `/activate` требует оба поля `windowId` и `tabIndex` — без них вернёт 400.
