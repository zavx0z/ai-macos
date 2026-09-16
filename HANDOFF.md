# Передача разработки через zavx0z

Срез: 16 сентября 2026. Checkout — `main`, исходный HEAD `46e1fc8`.
Продолжать в `/Users/zavx0z/repozitarium/ai-macos`; чужие изменения сохранять.

## Согласованный минимум

Один плагин **zavx0z**, один существующий Secure MCP Tunnel и один внешний
readonly-инструмент `zavx0z`. Последнее уточнение Владимира отменяет прежнее
согласование выполнения через этот инструмент: теперь он возвращает только
справку и контракты (`readOnlyHint:true`, `destructiveHint:false`).

Публичные метаданные минимальны: пустое description, inputSchema
`{"type":"object","properties":{}}`, без server instructions и заданной
outputSchema. Первый вызов `{}` получает данные сервера: справку, контракт
следующего запроса и доступные разделы. node/action/input объявляются только
в возвращённом контракте, а не в описании плагина.

```json
{}
{"node":"computer"}
{"node":"computer/system_health"}
{"node":"computer","action":"system_health"}
```

`node` раскрывает справку. Необязательный `action` выбирает контракт действия.
`input` — необязательные параметры; их наличие не запускает операцию.
Даже запрос с `action` и `input` возвращает только контракт и `executed:false`.
Прокси не подключается к Runtime и не получает его credential.
Контракт в ответе не регистрирует отдельный MCP-инструмент. Механизма выполнения
через это подключение сейчас нет; передачу действующего управления ChatGPT
считать завершённой нельзя. Новый исполнитель этим изменением не добавляется.

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

- `mcp/src/chat-proxy.ts` — только справка из snapshot; без Runtime-клиента,
  credentials, выполнения и polling.
- `mcp/src/catalog-snapshot.ts` — модуль, подготовленный ChatGPT; проверены SHA-256
  архива, приведены комментарии и форматирование к правилам репозитория.
- `mcp/src/catalog-server.ts` — необязательная identity/instructions сервера.
- `mcp/tests/chat-proxy.test.ts` — реальный MCP SDK: единственный readonly tool,
  необязательные поля, справка по изменяющей операции с параметрами без выполнения,
  отказ неизвестным и противоречивым путям.
- Snapshot фиксирует build и полные описания 14 внутренних операций. Это справка,
  а не доказательство актуальной готовности Runtime.
- После readonly-правки: 50 тестов snapshot/proxy/catalog и TypeScript MCP прошли.
  Исполняемый файл пересобран, backend того же туннеля обновлён; status ready.

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
После обновления регистрации интерфейс ChatGPT подтвердил «Чтение» без
«Изменение/Разрушительный», необязательные node/action/input и новое описание.
Уточнение передано проверочному чату на уровне «Высокий». Вызов справки
нового корня из самого чата ещё не проверен. Выполнение health/get_state
через этот инструмент удалено по последнему уточнению Владимира.

Логотип пользователя сохранён в `mcp/assets/zavx0z-logo.jpg` и `.png`.
PNG — 2460 bytes; рисунок не менялся. Замена значка существующего app через
доступный UI не найдена, его загрузка в ChatGPT не заявляется выполненной.
