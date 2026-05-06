# @meta/screen - REST API

REST-сервис для получения скриншотов macOS. Он дополняет
`@meta/window`: для снимка отдельного окна берет геометрию через
`WINDOW_API /windows`, поднимает окно через `WINDOW_API /raise`, делает
снимок региона через `screencapture`, затем best-effort возвращает фокус
предыдущему приложению через `WINDOW_API /focus`.

- Base URL: `http://localhost:7879` (override: `SCREEN_API`)
- Window API: `http://localhost:7878` (override: `WINDOW_API`)
- Формат скриншотов: `image/png`
- Координаты: логические пиксели macOS, origin `(0,0)` - top-left главного дисплея
- Авторизация: нет (только loopback)

> Требуются macOS-разрешения:
> - Screen Recording для процесса `bun`, который запускает `@meta/screen`
> - Accessibility для процесса `bun`, который запускает `@meta/window`

---

## 1. Карта голосовых интентов

| Голосовая фраза (RU)                               | Метод | Эндпоинт   | Body / Query |
|----------------------------------------------------|-------|------------|--------------|
| "сделай скриншот экрана / рабочего стола"          | GET   | `/desktop` | - |
| "сделай скриншот второго дисплея"                  | GET   | `/desktop` | `?display=2` |
| "сделай скриншот Chrome / браузера"                | GET   | `/window`  | `?app=Google%20Chrome` |
| "сделай скриншот второго окна Chrome"              | GET   | `/window`  | `?app=Google%20Chrome&index=2` |
| "сделай скриншот окна Chrome с заголовком GitHub"  | GET   | `/window`  | `?app=Google%20Chrome&title=GitHub` |
| "какие окна можно снять"                           | GET   | `/windows` | `?app=<app>` опционально |
| "сервер жив / проверь screen API"                  | GET   | `/health`  | - |

Нормализация имен приложений такая же, как в `@meta/window`: например,
"хром" -> `Google Chrome`, "сафари" -> `Safari`, "терминал" -> `Terminal`.

---

## 2. Эндпоинты

### 2.1 `GET /health`

Проверка живости screen-сервиса и доступности window-сервиса.

```bash
curl -s http://localhost:7879/health
```

Ответ:
```json
{
  "ok": true,
  "windowApi": "http://localhost:7878",
  "window": { "ok": true }
}
```

Если `@meta/window` не запущен, сам screen-сервис все равно отвечает
`ok: true`, но `window.ok` будет `false`.

---

### 2.2 `GET /desktop`

Скриншот всего рабочего стола.

Query:
- `display` опционально, номер дисплея для `screencapture -D`
- `format`: `png | json`, default `png`

```bash
curl -s http://localhost:7879/desktop -o /tmp/desktop.png
curl -s "http://localhost:7879/desktop?display=2" -o /tmp/display-2.png
```

JSON-вариант:
```bash
curl -s "http://localhost:7879/desktop?format=json" | jq -r .base64 | base64 -d > /tmp/desktop.png
```

Ответ `format=png`: binary `image/png`.

Ответ `format=json`:
```json
{
  "ok": true,
  "target": "desktop",
  "mime": "image/png",
  "base64": "..."
}
```

---

### 2.3 `POST /desktop`

То же, что `GET /desktop`, но параметры передаются JSON body.

Body:
```json
{ "display": 1, "format": "png" }
```

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"display":1}' http://localhost:7879/desktop -o /tmp/desktop.png
```

---

### 2.4 `GET /windows`

Прокси к `WINDOW_API /windows`, чтобы caller мог выбрать окно перед
снимком.

Query:
- `app` опционально, регистронезависимый фильтр на стороне `@meta/window`

```bash
curl -s "http://localhost:7879/windows?app=Google%20Chrome" | jq
```

Ответ:
```json
{
  "count": 1,
  "windows": [
    {
      "app": "Google Chrome",
      "pid": 123,
      "index": 1,
      "title": "GitHub",
      "x": 0,
      "y": 25,
      "width": 1440,
      "height": 900
    }
  ]
}
```

---

### 2.5 `GET /window`

Скриншот отдельного окна приложения.

Алгоритм:
1. Сохраняет frontmost app через System Events.
2. Берет окно из `WINDOW_API /windows?app=<app>`.
3. Поднимает окно через `WINDOW_API /raise` без активации приложения.
4. Ждет `delayMs` (default `150`).
5. Делает снимок региона через `screencapture -R x,y,w,h`.
6. Если `restore !== false`, возвращает фокус прежнему приложению через
   `WINDOW_API /focus`.

Query:
- `app` обязательно
- `index` опционально, default `1`
- `title` опционально, substring-фильтр по заголовку; если задан, имеет
  приоритет над `index`
- `restore`: `true | false`, default `true`
- `delayMs`: задержка после raise, default `150`, max `2000`
- `shadow`: `true | false`, default `true`; при `false` передается `screencapture -o`
- `format`: `png | json`, default `png`

```bash
curl -s "http://localhost:7879/window?app=Google%20Chrome" -o /tmp/chrome.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&index=2" -o /tmp/chrome-2.png
curl -s "http://localhost:7879/window?app=Google%20Chrome&title=GitHub" -o /tmp/github.png
```

JSON-вариант:
```bash
curl -s "http://localhost:7879/window?app=Google%20Chrome&format=json" \
  | jq -r .base64 | base64 -d > /tmp/chrome.png
```

Ответ `format=png`: binary `image/png` + headers:
- `x-meta-screen-target: window`
- `x-meta-window-app`
- `x-meta-window-index`
- `x-meta-window-title`
- `x-meta-window-restored`

Ответ `format=json`:
```json
{
  "ok": true,
  "target": "window",
  "mime": "image/png",
  "window": {
    "app": "Google Chrome",
    "index": 1,
    "title": "GitHub",
    "x": 0,
    "y": 25,
    "width": 1440,
    "height": 900
  },
  "restored": { "ok": true, "app": "Cursor" },
  "base64": "..."
}
```

---

### 2.6 `POST /window`

То же, что `GET /window`, но параметры передаются JSON body.

Body:
```json
{
  "app": "Google Chrome",
  "index": 1,
  "title": "GitHub",
  "restore": true,
  "delayMs": 150,
  "shadow": true,
  "format": "png"
}
```

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","index":1}' \
  http://localhost:7879/window -o /tmp/chrome.png
```

---

## 3. Модель ошибок

Все ошибки JSON: `{ "error": string }`.

| Код | Когда |
|-----|-------|
| 400 | Не хватает обязательного поля (`app`) |
| 404 | Окно не найдено |
| 500 | Ошибка `screencapture`, `osascript` или `WINDOW_API` |

Типичные причины:
- `screencapture failed`: нет Screen Recording-разрешения у терминала/Bun
- `WINDOW_API` refused/failed: не запущен `@meta/window`
- `osascript failed (-25211)`: нет Accessibility-разрешения у window-сервиса

---

## 4. Быстрые цепочки

Запуск сервисов:
```bash
cd /Users/vladimirfilipenko/meta/macos/window
bun run start

cd /Users/vladimirfilipenko/meta/macos/screen
bun run start
```

Скриншот Chrome с восстановлением фокуса:
```bash
curl -s "http://localhost:7879/window?app=Google%20Chrome&restore=true" \
  -o /tmp/chrome.png
```

Скриншот рабочего стола:
```bash
curl -s http://localhost:7879/desktop -o /tmp/desktop.png
```
