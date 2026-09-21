# Tools

Универсальные TypeScript-инструменты для файлов и Git. **10 файловых операций
и Git status**, без workspace/session-модели, регистрации корней, `roots`,
`open` и зависимостей от Interpreter. Подготовлены для встраивания в существующий
`zavx0z` (Завхоз); установленный плагин этим репозиторием не переключается.

## Прямые функции

Каждая функция принимает только свой Input. Второго аргумента-контекста нет.
Пути — абсолютные пути файловой системы, а не aliases. Текущий каталог процесса
не подставляется. Результаты файловых операций также содержат абсолютные пути.

```ts
import {readFile} from "./filesystem/read/index.ts"
import {writeFile} from "./filesystem/write/index.ts"
import {renamePath} from "./filesystem/rename/index.ts"

const file = readFile({path: "/work/project/src/index.ts"})
// Полный contentHash доступен только при чтении всего файла.
writeFile({path: file.path, content: "new contents\n", expectedHash: file.contentHash!})
renamePath({from: "/work/project/a.ts", to: "/work/another/b.ts"})
```

Файловые инструменты: `stat`, `list`, `read`, `read-many`, `write`, `create`,
`mkdir`, `remove`, `rename`, `apply-patch`. Git: `status`.
`apply-patch` принимает `{directory, patch, dryRun?}`: директория задаёт базу
относительных путей внутри патча, но не регистрирует workspace.
`git/status` принимает `{path, maxEntries?}`, где path — директория checkout.

## Структура и lazy MCP

У каждой операции собственные `index.ts`, `contract/input.ts`,
`contract/output.ts`, `spec/scenario.spec.ts`. Общие механизмы находятся у общего
владельца в `shared/`. `workspaces` в package.json — сборочная структура пакетов,
не состояние рабочих проектов. `exports` задают публичные входы.

`server/dispatch` предоставляет общий lazy-вход без запуска сервера или MCP:

```ts
import {createDispatcher} from "./server/dispatch/index.ts"

const tools = createDispatcher({
  repositoryRoot: "/installed/ai", // исходники описаний и контрактов
  authorize: invocation => hostPolicy.authorize(invocation), // политика вызывающего хоста
})

await tools.dispatch({node: "tools/filesystem/read", input: {view: "contract"}})
await tools.dispatch({
  node: "tools/filesystem/read", action: "run",
  input: {path: "/work/project/src/index.ts"},
})
```

`hostPolicy` в примере — зависимость интегрирующего хоста, не поставляемая
здесь заглушка. Без authorize разрешено описание, но **любое выполнение запрещено**.
Callback должен вернуть именно true; false, undefined или исключение не запускают
тулу. Аргументы копируются и замораживаются до ожидания разрешения.

Без action возвращается описание; `input.view: "contract"` раскрывает исходный
TypeScript, `"scenarios"` — исходник теста с `executed:false`. Только `action:"run"`
вызывает явно подключённую функцию. Произвольного import, shell или выбора
исполняемого файла по адресу node нет. Технические узлы сервера не исполняются.
Это lazy MCP, не отдельный продукт или SDK с другим названием.

## Необязательный HTTP-вход

Для встраивания в Завхоз он не нужен. Для отдельного доверенного HTTP-хоста:

```sh
bun install
export AI_TOOLS_ALLOWED_DIRECTORIES='["/absolute/path/to/project"]'
export AI_TOOLS_TOKEN="$(openssl rand -hex 32)"
bun run start
# Альтернатива: npm run start:node
```

По умолчанию `http://127.0.0.1:8787/tools`; адрес меняется через AI_TOOLS_HOST
и AI_TOOLS_PORT. `.env` автоматически не загружается. Нужны Bun либо Node.js 22.6+;
для status — установленный Git. Исполнение использует только стандартные модули.

GET /tools и POST /tools с {} возвращают обзор. Все запросы требуют
`Authorization: Bearer <token>`. POST принимает ту же оболочку node/action/input.
HTTP разрешает только пути внутри явно заданных директорий, проверяя физические
родительские пути и оба конца rename. Это политика хоста, не аргумент тулов.
AI_TOOLS_ROOTS больше не принимается: старые разрешения не расширяются молча.

## Границы

Прямые функции используют права вызывающего процесса. Это не OS sandbox и не
гарантия против враждебного локального процесса, меняющего пути между проверкой
и системным вызовом. Проверка expectedHash — защита от устаревшего содержимого,
не межпроцессная блокировка. `.git` для универсальных файловых функций является
обычным каталогом; решение разрешить доступ принадлежит вызывающему хосту.

Лимиты байтов, исключительное создание, запрет неявной рекурсии и перезаписи,
проверка патча и защита корня файловой системы сохранены. Частичный patch
возвращает PARTIAL_FAILURE с completed/current/cause, не обещание отката.
После неизвестного результата нельзя автоматически повторять изменение.

HTTP сохраняет Bearer-проверку, запрет браузерного Origin и лимит тела 12 MiB.
Содержимое файлов, входные аргументы и токены не пишутся в диагностический JSONL.
Для удалённого доступа нужен отдельно настроенный TLS-транспорт.

## Проверка и интеграция

```sh
bun run check
bun test
npm run test:node
```

Проверки используют только собственные временные директории. Результат этого
этапа и ограничения среды — в [VERIFICATION.md](VERIFICATION.md).
Переход со старого API — в [MIGRATION.md](MIGRATION.md).
Граница подключения к фактическому Завхозу — в [INTEGRATION.md](INTEGRATION.md).
Браузер, UI, debugger, replay, процессы Interpreter и самостоятельный MCP runtime
не являются частью этого репозитория или отложенным обязательством его переноса.
