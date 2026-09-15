# Агентский API Computer Use

## Принятый интерфейс

По поручению Владимира внешний API ai-macos повторяет JavaScript-интерфейс
Computer Use, поставляемый с установленным Codex. Основная точка входа — MCP
`js({ code, title?, timeout_ms? })` с постоянной JavaScript-сессией и объектом
`cua`. `js_reset({})` сбрасывает её переменные и привязки. Внутренние refs,
inventory revisions, client request IDs, leases и evidence не становятся
обязательными аргументами агента.

Это целевой контракт реализации. Наличие этого документа не означает, что
совместимый API уже установлен или прошёл живую проверку.

## Проверенный источник

Проверено 15 сентября 2026 по локальным файлам, без запуска Computer Use:

- `/Applications/ChatGPT.app`: bundle ID `com.openai.codex`, версия
  `26.908.40834`, build `8881`.
- Поставляемый пакет `@oai/cua` версии `0.2.4`, `@oai/cua-repl` версии `0.1.0`.
- Относительно `Contents/Resources/cua_node/lib/node_modules/@oai/cua/`:
  `docs/tinysky-alt-core-cua-repl.md` — инструкции агенту;
  `dist/lib/js/oai_js_cua/src/tinysky_alt/types.d.ts` — публичные типы;
  `dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js` — поведение
  привязок, автоматического вывода и перевода аргументов.
- SHA-256 инструкций:
  `67c0bd7f2d9ce350e3b7e6202505234a1defb980c14feaf75ed6bfe9d598de1a`.
- SHA-256 типов:
  `c30af1ebd90f50e4c061ba558433e265a734eda2e4ba9132e38505735df53220`.
- Дополнительные типы macOS: пакет `@oai/sky`, `docs/sky-window-api.md`.

[Официальное описание Computer Use](https://learn.chatgpt.com/docs/computer-use)
подтверждает назначение интеграции. Точные сигнатуры взяты из поставляемого
локального пакета. Это отдельный интерфейс от структурированных действий
[`computer` в Responses API](https://developers.openai.com/api/docs/guides/tools-computer-use).
Приватный IPC-сервис OpenAI не используется нашей реализацией.

## Приложения

```js
let state = await cua.getState()
let app = await cua.getApp("Google Chrome")
await app.getAXState()
await app.click(42)
await app.typeText("текст")
await app.pressKey("Return")
await app.getAXStateAndScreenshot()
```

| Метод | Аргументы | Результат |
| --- | --- | --- |
| `cua.getState` | `{ emit? }` | `{ apps, browsers, errors? }` |
| `cua.listApps` | `{ emit? }` | Массив `{ id, displayName?, isRunning?, lastUsedDate?, useCount? }` |
| `cua.getApp` | Имя, bundle ID или абсолютный путь приложения | Привязанный `App`; автоматически выводит полное AX-состояние |
| `app.getAXState` | `{ emit?, disableDiffing? }` | Строка AX-состояния |
| `app.getScreenshot` | `{ emit? }` | PNG как `Uint8Array` |
| `app.getAXStateAndScreenshot` | `{ emit?, disableDiffing? }` | `{ state, screenshot? }` |
| `app.click` | Индекс элемента или `[x, y]`, `{ mouseButton?, clickCount? }` | `void` |
| `app.drag` | `[fromX, fromY]`, `[toX, toY]` | `void` |
| `app.pressKey` | Клавиша или сочетание в синтаксисе X keysym | `void` |
| `app.typeText` | Строка | `void` |
| `app.scroll` | Индекс или `[x, y]`, направление, `pages?` | `void` |
| `app.paste` | Строка, `{ format?: "text" | "md" | "html" }` | `void` |
| `app.selectText` | Индекс, строка, `{ prefix?, suffix?, selectionType? }` | `void` |
| `app.setValue` | Индекс, строка | `void` |
| `app.performSecondaryAction` | Индекс, название объявленного AX-действия | `void` |

Все методы асинхронны. Кнопки мыши: `left/right/middle` и `l/r/m`;
направления: `up/down/left/right` и `u/d/l/r`. `selectionType` принимает
`text`, `cursor_before`, `cursor_after`. По умолчанию click — один левый клик,
scroll — одна страница, paste — plain text.

Координаты относятся к снимку окна приложения. Число в `click(42)` — индекс
из последнего выданного AX-состояния, а не постоянная личность элемента.
Индекс связывается с retained native element и точным snapshot внутри runtime.
После действий агент получает новое AX-состояние. После одного screenshot
перед индексными действиями требуется полное AX-состояние.

Наблюдения выводятся автоматически; `emit:false` подавляет вывод, сохраняя
возвращаемое значение. `nodeRepl.write` выводит текст/значения,
`nodeRepl.emitImage` — изображение. Повторного автоматического изображения
после каждого действия в этом контракте нет.

## Браузеры

Тот же объект `Target` доступен через `cua.getTab(id, { browser? })` и
`cua.createBrowserTab(browserId, url?, { visible?, sessionName? })`.
`cua.getBrowser({ id?, url? })` выбирает браузер без создания вкладки;
`cua.listBrowsers({ emit? })` и `cua.listTabs({ browser?, emit? })`
возвращают инвентаризацию. Вкладка дополнительно имеет `id`, `goto`, `back`,
`forward`, `reload`, `close`, `markDeliverable`, `markHandoff`.

Отсутствующая возможность провайдера выдаёт явную ошибку. Параметры видимости
и имени сессии применяются до создания вкладки. Browser target identity,
собственность ADB forward и отмена сохраняются внутри существующих adapters.

## Граница совместимости и внутренние гарантии

- Совместимы имена, аргументы, возвращаемые значения, постоянные JS-привязки
  и правила автоматического вывода проверенной версии API.
- Разрешение приложения внутри ai-macos заканчивается точной process/window
  identity. Неоднозначность нескольких Chrome-процессов не разрешается
  выбором первого совпадения. Существующее окно не подменяется новым браузером.
- Координаты используют сохранённый снимок и его преобразование. Нельзя
  молча снять новый кадр и выдать его за ранее показанный агенту.
- AX-действия выполняются настоящим Accessibility backend. `setValue`,
  `selectText` и AXPress не заменяются набором текста или кликом в выдуманный
  центр элемента.
- Native paste должен сохранять и условно восстанавливать все прежние
  pasteboard formats; пользовательская новая запись имеет приоритет.
- Ошибка, отмена, разрыв MCP или timeout не повторяют уже начатое действие.
  Сброс REPL не является доказательством завершения native cleanup.
- Приватные механизмы OpenAI для background/locked use, его разрешения на
  приложения и UI панели не объявляются реализованными через совпадение API.

## Приёмка

Для завершения нужны contract tests на приведённые вызовы, автоматический
вывод, координаты снимка, свежие AX-индексы, Unicode, formatted paste,
длительную JS-сессию, отмену и reset. Затем — настоящий direct MCP путь
из Codex через наш `js` до native/browser backend. Заглушка capability-unavailable
показывает незавершённую возможность и не закрывает приёмку полного интерфейса.
