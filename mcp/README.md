# MCP и подключение ChatGPT

Рабочий путь ChatGPT:

`ChatGPT → Secure MCP Tunnel → zavx0z-mcp → runtime.sock → computer-use.app → Native helper`

Локальный alias/profile туннеля — `ai-macos-chat`. Его удалённое отображаемое
имя может быть `ai-macos-local`; это не имя запускаемого legacy MCP.
Прокси — отдельный исполняемый файл, Runtime и Native — согласованный
подписанный bundle. Перезапуск туннеля не устанавливает изменения Runtime.

`src/chat-proxy.ts` публикует единственный инструмент `zavx0z`.
[Протокол](protocol.md) описывает `node`, `action`, `input` и динамическую справку.
`src/installed-launcher.ts` остаётся отдельным direct MCP launcher установленного
Runtime. `src/index.ts` — legacy путь: его правка не обновляет `zavx0z`.
Старые REST-сервисы для этого подключения не запускаются.

## Снимки и PiP

`src/screenshot-ui.ts` содержит один просмотрщик. Его текущая конфигурация
`chatScreenshotUiHtml` использует кадр из конкретного tool result, без общего
latest-frame между беседами, аренды владельца и периодического опроса.
Последовательные доставленные кадры меняют один `img`; запоздавшие кадры
предыдущей версии или предыдущего stream не заменяют новые.

Прокси сохраняет `ImageContent` для зрения модели и добавляет снимок в `_meta`
для UI. Удалять модельный кадр ради сокрытия изображения в интерфейсе нельзя:
агент потеряет наблюдение. Агент не должен дополнительно вставлять этот снимок
Markdown-картинкой в ответ. Отображением tool result управляет ChatGPT.

После первого кадра просмотрщик запрашивает PiP, если хост предоставляет этот
API. Успешный capture не подтверждает открытия виджета. Обновление одного
смонтированного viewer проверяется тестом; сохранение одного PiP между вызовами
и отсутствие дополнительных карточек требуют проверки именно в ChatGPT.
Если хост создаёт новый iframe на каждый вызов единственного tool, локальный
таймер или глобальная аренда не исправляют этот контракт.

Основание: [официальная документация UI](https://developers.openai.com/plugins/build/chatgpt-ui)
и [метаданные результатов](https://developers.openai.com/plugins/reference).
Документация предупреждает о повторном создании iframe при шаблоне на каждом tool.

## Обновление и восстановление

Внешний оператор запускает из canonical checkout:

```sh
bun scripts/chat-proxy-install.ts
bun scripts/chat-proxy-install.ts --execute --credential-service dev.knowledge-base.tunnel
```

Первая команда только печатает план. Вторая требует чистое дерево, собирает
кандидат, проверяет initialize/tools/list/resources и корневую справку,
останавливает **всю** управляемую tunnel session, атомарно меняет бинарник,
поднимает тот же alias/profile/tunnel и проверяет health/ready. При ошибке —
один rollback прежнего бинарника. Регистрация плагина и Runtime не меняются.

Credential берётся из существующей ссылки профиля. Если переменная окружения
не задана, `--credential-service` указывает существующую запись Keychain;
ключ не выводится и не сохраняется в исходниках или отчёте установки.
В `Application Support/ai-macos/chat-proxy/update.json` записываются commit,
SHA256 кандидата/предыдущей сборки и итоговая фаза. `update.lock` защищает от
параллельных обновлений. После аварийного прерывания сначала исследовать журнал
и процессы; не удалять lock автоматически.

Для восстановления без пересборки используется `tunnel-client runtimes connect`
с существующим alias `ai-macos-chat`, tunnel ID и командой из профиля. Точные
аргументы и credential reference берутся из установленной конфигурации;
`tunnel-client runtimes status ai-macos-chat --json` проверяет результат.

**Не выполнять `kill` дочернего `zavx0z-mcp`.** Его выход завершает туннель.
Не обновлять управляющий канал через Terminal, которым управляет этот же канал.
Восстановление выполняет внешний Codex/shell либо оператор.

Runtime устанавливается отдельно через `scripts/runtime-install.ts` с прежней
подписью и выбранным readiness profile. Правки retention в исходниках вступают
в силу только после этой установки.

## Проверки

```sh
bun test mcp/tests/catalog-server.test.ts mcp/tests/chat-proxy.test.ts mcp/tests/runtime-mcp.test.ts mcp/tests/screenshot-ui.test.ts scripts/chat-proxy-install.test.ts
bunx tsc --noEmit -p mcp/tsconfig.json
```

Это проверки протокола, UI-логики и процедуры установки без реального ввода.
Живая приёмка: ChatGPT вызывает `{}`, `system_health`, наблюдает выбранную цель
и подтверждает открытие и обновление PiP. Установщик этого не имитирует.
