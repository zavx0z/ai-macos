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
chrome reload       [--window <id>] [--index <n>]
chrome back         [--window <id>] [--index <n>]
chrome forward      [--window <id>] [--index <n>]
chrome eval         --js "<code>" [--window <id>] [--index <n>]
chrome source       [--window <id>] [--index <n>]
chrome text         [--window <id>] [--index <n>]
chrome screenshot   [--window <id>] [--index <n>] [--out <path>] [--shadow false] [--delayMs 200]
```

`chrome screenshot` без `--out` сохраняет PNG в `./tmp/screenshots/chrome-<ts>.png` и печатает JSON `{ ok, path, bytes }`.
