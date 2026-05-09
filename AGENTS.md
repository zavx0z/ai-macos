# @meta/macos — правила для AI-агентов

## Структура

Bun monorepo. Четыре пакета:

| Пакет | Порт | Назначение |
|---|---|---|
| `@meta/shared` | — | Общие утилиты: http, osa, params, log |
| `@meta/window` | 7878 | Управление окнами macOS через Accessibility API |
| `@meta/screen` | 7879 | Скриншоты через `screencapture` |
| `@meta/chrome` | 7880 | Управление Google Chrome через AppleScript |

Зависимости: `chrome` → `screen` → `window` → (system).

## Запуск сервисов

```bash
cd /Users/vladimirfilipenko/meta/macos
cd window && bun src/index.ts   # порт 7878
cd screen && bun src/index.ts   # порт 7879
cd chrome && bun src/index.ts   # порт 7880
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
| Значение | Масштаб | Размер |
|---|---|---|
| `low` | 25 % | ~200 КБ |
| `medium` | 50 % | ~400 КБ |
| `high` | 75 % | ~600 КБ |
| `full` | 100 % | ~900 КБ |

Формат `json` вместо `png` → `{ ok, target, mime, base64 }`.

## @meta/chrome — порт 7880

Health: `{ ok, running }` — `running: false` означает Chrome не запущен.

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
# → { ok, windowId, tabIndex }   ← сохрани windowId для следующего /screenshot!
curl -X POST http://localhost:7880/reload -H 'content-type: application/json' \
  -d '{"windowId":12345,"tabIndex":2}'
# → { ok, hard, waited, waitMs }  — по умолчанию ждёт окончания загрузки (до 10 с)
# hard: true  → Cmd+Shift+R (сброс кеша, переносит фокус на Chrome)
# wait: false → вернуть немедленно, не ждать загрузки
curl -X POST http://localhost:7880/back
curl -X POST http://localhost:7880/forward

# Контент (требует View → Developer → Allow JavaScript from Apple Events)
curl -X POST http://localhost:7880/eval \
  -H 'content-type: application/json' -d '{"js":"return document.title"}'
# → { ok, result }
curl http://localhost:7880/source              # outerHTML (text/html)
curl http://localhost:7880/text                # innerText (text/plain)
curl "http://localhost:7880/source?windowId=12345&tabIndex=2"

# Скриншот — всегда передавать windowId (из /windows или из ответа /activate) и caption
curl -s -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"windowId":12345,"detail":"medium","caption":"Ожидаю увидеть главную страницу с навигацией"}' -o chrome.png
# Без windowId берётся первое окно Chrome — может быть не то!
# caption логируется до захвата, возвращается в x-meta-caption заголовке
```

## Правила для агентов

1. **Перед каждым скриншотом** — сформулировать одним предложением, что ожидается увидеть, и передать это в поле `caption`. После получения изображения — сравнить ожидание с реальностью и сообщить о расхождении.
2. Перед первой операцией с сервисом вызвать `GET /health`. При ошибке — сообщить пользователю, не ретраить.
3. При `granted: false` от `/permissions/*` — вызвать `POST /permissions/*` (откроет Settings), сообщить пользователю, не ретраить.
4. Для скриншотов передавать `detail="medium"` если пользователь не указал иное.
5. Использовать только REST API — никакого прямого `osascript`, `screencapture` или AppleScript.
6. Имя приложения (`app`) — каноническое имя процесса macOS, строго по системному.
7. `windowId` в Chrome-сервисе — стабильный AppleScript ID из `GET /windows`. **Всегда передавать `windowId` в `/screenshot`** — без него берётся первое окно и можно попасть на неверное.
8. Для скриншота Chrome использовать `POST /screenshot` у `@meta/chrome`, **не** напрямую в `@meta/screen` (`/window` или `/rect` не видят Chrome без Accessibility).
   Сценарий: `GET /windows` → взять нужный `windowId` → `POST /activate {windowId, tabIndex}` → `POST /screenshot {windowId, detail, caption}`.
9. `hard: true` в `/reload` переносит фокус на Chrome — использовать только если пользователь явно просит сбросить кеш.
10. `/activate` требует оба поля `windowId` и `tabIndex` — без них вернёт 400.
11. При ошибке `osascript failed (-1743)` — нет разрешения Automation.
12. При ошибке `osascript failed (-25211)` — нет разрешения Accessibility.
13. **Canvas-приложения** (графики, редакторы, кастомные рендереры): `POST /screenshot` снимает окно Chrome целиком, но canvas-пиксели могут не совпасть из-за DPR-масштабирования или тайминга. Вместо этого использовать `POST /eval` с JS `return document.querySelector('canvas').toDataURL('image/png')` — получить base64-строку, отрезать префикс `data:image/png;base64,`, декодировать через `base64 -d` в PNG-файл. При нескольких canvas — `document.querySelectorAll('canvas')[N]`.
