# Передача разработки через zavx0z

Срез: 16 сентября 2026. Checkout — `main`, исходный HEAD `46e1fc8`.
Продолжать в `/Users/zavx0z/repozitarium/ai-macos`; чужие изменения сохранять.

## Действующий контракт

Один плагин **zavx0z**, прежний Secure MCP Tunnel и один MCP-инструмент.
Публичные метаданные: пустое description, inputSchema
`{"type":"object","properties":{}}`, без server instructions и outputSchema.
Первый вызов `{}` возвращает данные сервера: справку, контракт и разделы.

```json
{}
{"node":"computer"}
{"node":"computer/system_health"}
{"node":"computer","action":"system_health"}
```

Без `action` запрос раскрывает справку, даже если передан `input`.
С `action` запрос исполняется; `input` необязателен, по умолчанию `{}`.
Путь `computer/<операция>` также допускает соответствующий ему `action`;
противоречие между путём и действием отклоняется.

Владимир поручил восстановить исполнитель после проверки readonly-варианта.
Справка не имеет побочных эффектов, однако единственный внешний tool также
умеет выполнять изменяющие операции: `readOnlyHint:false`,
`destructiveHint:true`, `idempotentHint:false`. Пустая схема сохраняется.

Исполнитель лениво подключается к существующему Runtime, проверяет машину,
build и полный контракт вызываемой операции. Действие не повторяется.
Runtime сохраняет проверку admission, capabilities и наблюдений. Пассивный
`system_health` доступен для диагностики несовпадений; status/cancel не зависят
от готовности остальных операций. Clipboard и shell/workspace API не добавлены.

## Действующее подключение

- ChatGPT app: `asdk_app_6aa9efb59650819182f89b36ac93f119`.
- Tunnel: `tunnel_6a883a5f7ea481918bfc72e88eeb924e`.
- Локальный управляемый alias: `ai-macos-chat`.
- Профиль: `~/Library/Application Support/ai-macos/tunnel/profiles/ai-macos-chat.yaml`.
- Предыдущий профиль: рядом, `ai-macos-chat.before-zavx0z.yaml`.
- Новый backend: `~/Library/Application Support/ai-macos/chat-proxy/zavx0z-mcp`.
- Snapshot: там же, `catalog-v1.json`.
- Двоичный файл tunnel-client уже установлен в
  `~/Library/Application Support/knowledge-base/tunnel/bin/tunnel-client`.
  Он использован без переустановки или изменения Knowledge Base.
- Credential туннеля получен из существующей пользовательской Keychain и передан
  через окружение. Ключей в репозитории и snapshot нет. Runtime UDS credential
  остаётся в приватном каталоге ai-macos, не передаётся ChatGPT.

Прокси заменяет backend того же туннеля. Второй Runtime/Native не запускается.
Подписанный `computer-use.app` не менялся: source `61d1e9d`, build
`runtime-47a1c96c07f1223d1fbf6e13` / `native-47a1c96c07f1223d1fbf6e13`.
Туннель управляется штатным `tunnel-client runtimes`, текущий запуск — tmux;
автозапуск после перезагрузки Mac этим изменением не установлен.

## Код и проверки

- `mcp/src/chat-proxy.ts` — пустой публичный вход и раскрытие протокола.
- `mcp/src/chat-executor.ts` — выполнение через private Runtime UDS без polling.
- `mcp/src/catalog-snapshot.ts` — модуль ChatGPT для проверки целостности snapshot
  и совместимости каталога; snapshot содержит 14 существующих операций.
- 51 тест snapshot/proxy/catalog и TypeScript MCP прошли. MCP SDK + тестовый
  RuntimeHost/UDS проверяют справку без подключения, поздний старт Runtime,
  выполнение ровно один раз, необязательный input, сохранение отказа Runtime,
  allowlist и get_operation при закрытом admission. Настоящий ввод не запускался.
- Исполняемый файл пересобран; backend прежнего туннеля обновлён, status ready.

Незакоммиченный ETag/304-черновик в `runtime/src/{method-registry,transport}.ts`
и соответствующих тестах сохраняется отдельно. Он прошёл 28 targeted tests
и TypeScript после исправления двух тестовых casts. Установленный Runtime
его ещё не использует. Исходный каталог — 2 900 445 bytes; его повторное
чтение каждым MCP-клиентом с секундной паузой давало лишнюю нагрузку.

## Ограничения и следующая проверка

Все findings корневого `REVIEW.md` остаются открытыми, кроме отдельно
подтверждённых изменений. Native неоднократно автоматически перезапускался;
повседневная стабильность ввода ещё не принята. Не выдавать доступность
инструмента за successful input, не повторять partial/unknown действие.

Проверочный чат уже перенесён в проект Computer Use:
`https://chatgpt.com/g/g-p-6aa9a6291c808191b0fedeca6fcb3608/c/6aa9f133-ecec-83eb-9bf1-6b8e0d4bbfa3`.
В нём выполнен настоящий прежний `system_health`. В старой Pro-беседе другой
ветки сервер ChatGPT вернул `This conversation does not support developer MCPs`.
Из этого чата подтверждены реальные вызовы пустого входа, справки и
восстановленного system_health: repositarium, matchesExpected:true,
Runtime/Native build 47a1c96c07f1223d1fbf6e13, observer ready на момент ответа.
Следующий get_state остановлен проверкой текущего каталога: INVALID_CATALOG,
Missing or invalid selected tool: get_state. Операция не повторялась. Полная
передача управления пока не подтверждена: статический контракт имеется, но
в текущем каталоге Runtime операция отсутствовала при проверке.

Диагностика процессов: три installed-launcher/--mcp относятся к Codex desktop
app-server, ещё один — к Codex ACP в WebStorm. Это отдельные MCP-клиенты.
На момент проверки Runtime-процесс без --mcp был один. Новый zavx0z-mcp
не использует polling; старые установленные MCP-клиенты его продолжают.

Логотип пользователя сохранён в `mcp/assets/zavx0z-logo.jpg` и `.png`.
PNG — 2460 bytes; рисунок не менялся. Замена значка существующего app через
доступный UI не найдена, его загрузка в ChatGPT не заявляется выполненной.
