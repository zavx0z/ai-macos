# @meta/macos — правила для Claude Code

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
cd window && bun run src/index.ts
cd screen && bun run src/index.ts
cd chrome && bun run src/index.ts
```

## Скриншоты (@meta/screen, порт 7879)

Уровни детализации (`detail`):

| Значение | Масштаб | Типичный размер |
|---|---|---|
| `low` | 25 % | ~200 КБ |
| `medium` | 50 % | ~400 КБ |
| `high` | 75 % | ~600 КБ |
| `full` | 100 % | ~900 КБ |

Можно передавать как строку `detail=medium` или как число `scale=0.5`.

Скриншот области (предпочтительный метод для Chrome):
```bash
curl -X POST http://localhost:7879/rect \
  -H 'content-type: application/json' \
  -d '{"x":0,"y":0,"width":1920,"height":1200,"detail":"medium"}'
```

Скриншот окна:
```bash
curl -X POST http://localhost:7879/window \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","detail":"medium"}'
```

## Скриншоты Chrome (@meta/chrome, порт 7880)

```bash
curl -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"detail":"medium"}'
```

Параметры `detail` и `scale` передаются транзитом в `@meta/screen`.

## Управление окнами (@meta/window, порт 7878)

Используй только REST API, не AppleScript напрямую.

```bash
# Перемещение и размер
curl -X POST http://localhost:7878/arrange \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","preset":"left"}'

# Фокус
curl -X POST http://localhost:7878/focus \
  -d '{"app":"Google Chrome"}'
```

## Важные правила

- Никогда не использовать `osascript` / AppleScript напрямую — только через REST API сервисов.
- Перед первой операцией вызвать `GET /health` нужного сервиса.
- `@meta/screen` требует разрешение Screen Recording; `@meta/window` — Accessibility.
- Для скриншота вкладки Chrome использовать `POST /screenshot` у `@meta/chrome`, а не напрямую `/rect` у `@meta/screen` (Chrome сам вычислит координаты окна).
- При ошибке `osascript failed (-1743)` — нет разрешения Automation. Сообщить пользователю, не ретраить.
- При ошибке `osascript failed (-25211)` — нет разрешения Accessibility. Сообщить пользователю, не ретраить.
- Имена приложений в `app` — каноническое имя процесса macOS (например `"Google Chrome"`, не `"chrome"`).
