# ai-macos — правила для AI-агентов

## Действующая архитектура

Основной агентский интерфейс — direct MCP `ai-macos` поверх одного Runtime
и одного долгоживущего Native broker. Установленное приложение —
подписанный `computer-use.app`; transport — private authenticated Unix socket.

| Пакет | Ответственность |
| --- | --- |
| `@meta/shared` | Контракты, схемы, capability IDs |
| `@meta/runtime` | Клиенты, методы, операции, leases, recovery и lifecycle |
| `@meta/native` | AppKit/AX/CoreGraphics/ScreenCaptureKit, registry и executor |
| `@meta/input` | Планирование ввода и clipboard adapters |
| `@meta/screen` | Capture adapter, observations и координаты |
| `@meta/chrome` | CDP adapter с точной browser/target identity |
| `@meta/android` | Выбранное ADB-устройство и Chrome CDP adapter |
| `mcp` | Installed launcher и публикация runtime catalog |

Старые REST/CLI entrypoints, пакет `window` и порты 7878–7882 остаются в
исходниках до завершения миграции. Не запускать их как второй контур управления.
Root `bun run dev` ещё относится к legacy сервисам, а не установленному runtime.

Текущее состояние: [журнал запуска](docs/reviews/startup-permissions-and-identity.md),
[план перехода](docs/reviews/cutover-readiness.md).
Документы содержат датированные результаты; текущую готовность проверять live.

## Управление компьютером

1. Прочитать [навык ai-macos](skills/ai-macos/SKILL.md). Использовать только
   объявленные в текущей задаче `mcp__ai_macos__*`.
2. Первым вызвать пассивный `system_health` и проверить
   `machine.matchesExpected === true`. Другой диагностический клиент
   не доказывает обновление каталога этой задачи.
3. В коротком API выбрать цель через `get_state`/`get_tabs`.
   `targetId` выдаёт Runtime. PID, заголовок, URL, геометрия и индекс не
   заменяют identity. Новый процесс/окно не наследует прежний handle.
4. Native-цикл: `observe` → одно действие → новое `observe`.
   Вмешательство пользователя, потеря coverage и истечение наблюдения
   требуют нового observe. Не восстанавливать автоматически старый фокус.
5. Перед мышью/клавиатурой выполнить отдельный `check_input`, если он объявлен.
   В старом каталоге — `input_readiness`. Продолжать только при фактической
   готовности ввода. Health не выполняет активную проверку.
6. Перед снимком сформулировать ожидание в `caption`; по умолчанию
   `detail: "medium"`, если поле объявлено схемой. Сравнить изображение с
   ожиданием. Доставка ввода не доказывает эффект в приложении.
7. Координаты брать из свежего observation в его системе координат.
   `elementId` принадлежит AX snapshot. При exact target нельзя подбирать
   похожее окно по заголовку, URL или геометрии.
8. После timeout/unknown не повторять действие. Запросить operation status;
   при потерянном ответе использовать `list_recent_operations`. Запрос cancel
   не доказывает завершение cleanup.
9. Clipboard читать только по явному поручению. Text-only восстановление
   не считать восстановлением всех форматов pasteboard.
10. При отсутствии инструмента, прав или coverage остановить зависимое действие.
    REST, AppleScript, shell-ввод, `screencapture`, встроенные Codex Computer Use
    и AppShot не являются fallback.

Диагностика может читать metadata, подписи и состояние собственных сервисов,
выполнять MCP initialize/tools/list/passive health. Отдельный диагностический
клиент не используется для desktop-действий. Fake tests и компиляция Native
не считаются live-проверкой управления.

## Окна, браузеры и Android

- Неполный inventory не означает закрытие отсутствующих в нём окон.
  Различать hidden/minimized, отсутствие AX, процесс без окон и CG-only записи.
- Sheet имеет собственную identity и точного owner. Не подменять его родителем
  по пересечению координат.
- `show_window` показывает выбранное существующее окно, не создаёт браузер.
- Chrome выбирается по объявленной browser instance/profile и CDP target.
  Одинаковый URL в разных профилях не делает targets взаимозаменяемыми.
- Storybook использует только собственный специализированный MCP/private browser.
- Android опционален: нужны объявленная capability, точные serial/transport
  и подтверждённое USB Debugging. Отсутствующее устройство не заменять другим.
- Не устанавливать ADB автоматически, не перезапускать общий ADB server и
  не удалять чужие forwards. Системные зависимости — через MacPorts.

## Права macOS и подпись

По поручению пользователя Runtime при запуске запрашивает отсутствующие
Accessibility, Screen Recording, Post Events и Input Monitoring. Официальные
request API вызывает Native helper; повторные health/MCP calls их не вызывают.

`startup.permissions.missing` означает, что текущий helper не подтвердил право.
Пользователь мог его уже включить. Различать настройки macOS, текущий процесс
и подпись; не повторять просьбы о выдаче прав при проблеме обновления процесса.
`requestIssued` не доказывает появления диалога. Вне startup-потока повторный
запрос требует явного поручения. Все grants не заменяют готовность observer.

Сохранять постоянную certificate identity при обновлениях. Нельзя молча менять
сертификат или возвращаться к ad-hoc. Создание/импорт приватного ключа требует
отдельного согласования. Ключи и пароли не записывать в репозиторий или логи.
Стабильная подпись не гарантирует сохранение всех TCC grants: проверять их.

## Установка и проверки

Владелец установки — `scripts/runtime-install.ts`. Без `--execute` он выдаёт
план. Нужны clean canonical checkout, `AI_MACOS_EXPECTED_HOSTNAME`, profile
и browser configuration. Сертификат выбирается через `--signing-identity-sha1`
и при необходимости `--signing-keychain`; fingerprint брать из локальной identity.

Профиль `--desktop-browser-selected` требует pointer, drag, application lifecycle
и observer. `input.interaction` (focus session с automatic restore) явно отложен.
Не уменьшать required set ради успешного doctor. Android — только при config.

Установщик подписывает helper, затем app, проверяет hashes/designated requirements,
выполняет drain и переход с rollback journal. Не заменять внутренние файлы
подписанного app вручную. Не редактировать TCC DB.
Legacy `input/bin/meta-input-helper` не является helper нового bundle.

Installed MCP launcher — `mcp/src/installed-launcher.ts`: проверяет release и
стабильный app, запускает `--mcp` без source/REST fallback.
Изменение config не заменяет старое открытое соединение.

Проверять затронутые Bun suites/TypeScript; Native —
`sh native/scripts/check.sh` и `sh native/scripts/check-observer.sh`.
Тесты с настоящим вводом не запускать как обычную suite: требуется точная
тестовая цель и direct MCP preflight. Ведущий координирует live-проверки,
установку и изменение собственных процессов.

## Завершение миграции

Удаление legacy source — только по актуальному
[плану](scripts/legacy-source-removal-plan.json) после его проверок.
Нужны installed doctor, новое рабочее direct MCP подключение, subprocess/security
tests и сведения о [потребителях](docs/legacy-callers.md).
Не выдавать успешную установку за полную live-приёмку.

## Git и рабочие каталоги

Работать в исходном canonical checkout внутри `/Users/zavx0z/repozitarium`
и в той же ветке. Без прямого поручения нельзя создавать/переключать ветки,
клоны и worktrees. Архивный `/Users/zavx0z/production` и его процессы
не читать и не изменять. Чужие незакоммиченные изменения сохранять.

Git-операции выполнять в пределах поручения пользователя. Действующее поручение
о промежуточных commit/push сохраняется между сообщениями.
Новый и изменяемый TS/JS писать без завершающих точек с запятой.
Авторские комментарии и документация — на русском.
