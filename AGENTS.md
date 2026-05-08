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

## Скриншоты

Параметр `detail` задаёт уровень детализации:

- `"low"` → 25 % от Retina-разрешения
- `"medium"` → 50 %
- `"high"` → 75 %
- `"full"` → 100 % (оригинал)

Альтернатива — числовой `scale` от 0.0 до 1.0.

По умолчанию (без параметра) — полное разрешение Retina (~3840 px, ~900 КБ).

Рекомендуется `detail=medium` для задач с vision-моделями (баланс качество/размер).

### Скриншот вкладки Chrome

```bash
curl -s -o screenshot.png -X POST http://localhost:7880/screenshot \
  -H 'content-type: application/json' \
  -d '{"detail":"medium"}'
```

### Скриншот окна по приложению

```bash
curl -s -o screenshot.png -X POST http://localhost:7879/window \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","detail":"medium","shadow":false}'
```

### Скриншот области экрана

```bash
curl -s -o screenshot.png -X POST http://localhost:7879/rect \
  -H 'content-type: application/json' \
  -d '{"x":0,"y":0,"width":1920,"height":1200,"detail":"medium"}'
```

## Управление Chrome

```bash
# Навигация
curl -X POST http://localhost:7880/navigate \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

# Активная вкладка
curl http://localhost:7880/tabs/active

# Выполнить JS
curl -X POST http://localhost:7880/eval \
  -H 'content-type: application/json' \
  -d '{"js":"return document.title"}'

# HTML страницы
curl http://localhost:7880/source

# Текст страницы
curl http://localhost:7880/text
```

## Управление окнами

```bash
# Расположить окно по пресету
curl -X POST http://localhost:7878/arrange \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","preset":"right"}'
# Пресеты: left, right, top, bottom, max, center

# Переключить фокус
curl -X POST http://localhost:7878/focus \
  -H 'content-type: application/json' \
  -d '{"app":"Google Chrome"}'
```

## Проверки разрешений

```bash
curl http://localhost:7878/permissions/accessibility
curl http://localhost:7879/permissions/screen-recording
```

## Правила для агентов

1. Перед первой операцией с сервисом вызвать `GET /health`. При ошибке — сообщить пользователю, не ретраить.
2. Для скриншотов передавать `detail="medium"` если пользователь не указал иное.
3. Использовать только REST API, никакого прямого `osascript` или `screencapture`.
4. Имя приложения (`app`) — каноническое имя процесса macOS, строго соответствующее системному.
5. При ошибке разрешений (коды -1743, -25211, "not authorized") не ретраить, сообщить пользователю.
6. `windowId` в Chrome-сервисе — это стабильный AppleScript ID из `GET /windows`, предпочтительнее `index`.
