# Готовность установленного computer-use и удаления legacy source

Срез ведущего: 16 сентября 2026 года. Source checks, установленная сборка и
реальные действия проверяются отдельно. Зелёные unit tests не закрывают live gates.

## Установленная версия

Последний подтверждённый installed checkpoint — source `990e548`, release
`release-87f82221cfe2798f2c1d11c0`, runtime/native build suffix
`70f57be1e9fe2dce6fd970e0`. Последующие коммиты требуют новой установки.

- Стабильный подписанный bundle: `Application Support/ai-macos/runtime/computer-use.app`.
- Executable: `Contents/MacOS/computer-use`; Native: `Contents/Helpers/meta-input-helper`.
- Имя `computer-use` и тематическая иконка подтверждены скриншотом пользователя.
- Accessibility, Screen Recording, Post Events и Input Monitoring сохранены
  после обновления; observer и view ready.
- Новая Codex-задача получила все 36 direct MCP tools версии `0.4.0`.
  Старый каталог root-задачи `0.3.0` не используется для приёмки новой версии.
- Выбран профиль `desktop-browser-selected`: короткий API поверх собственного
  runtime. `input.interaction`, продолжение клавиатурного ввода между операциями
  и автоматическое восстановление прежнего фокуса отложены явно.
- Chrome использует заранее настроенный внешний CDP endpoint. Runtime не
  запускает другой профиль, чтобы скрыть ошибку обнаружения. Android не проверен
  live; последнее наблюдение ADB не содержало подключённого устройства.

## Подтверждённые реальные действия

Используется собственная AppKit fixture из
`tests/computer-use/fixtures/app/main.m`; её stdin hook только читает состояние.
Все desktop-действия выполняет direct ai-macos MCP в задаче
«Computer use: финальная проверка установленной версии».

| Проверка | Наблюдаемый результат |
| --- | --- |
| Два одинаковых заголовка | Primary и secondary различаются точными AX identifiers и refs |
| AX | Возвращаются RU/EN/emoji/composed text, slider value, parent relationships и нулевые frame невидимых элементов |
| Снимок primary | Получен и просмотрен PNG 280×234; содержание соответствует fixture, cleanup complete, Native generation не изменилась |
| `check_input` | Move и restore posted/observed/readback confirmed, cursor восстановлен, cleanup complete |
| `show_window` | Одна операция show успешно возвращает точное окно; ошибочного второго focus и malformed wrapper больше нет |
| AXPress `fixture.sheet.open` | Одна операция completed, exact target verified, cleanup complete; oracle подтвердил `sheet-opened` и `sheet.open=1` |

Основные receipts текущего checkpoint:

- input readiness: `operation:12f644c5-2939-4c56-8dc7-f398242bd564`;
- AXPress: `operation:95dc9286-c8ae-4bb1-ac1a-e98c80b4625b`;
- runtime epoch: `runtime:41f8691f-ed6b-44d1-9e70-4fabe86c3594`;
- Native generation: `native-A61E58EC-E567-4350-85DE-03BD421C7661`.

Receipt `effect: unverified` сам по себе не подтверждает эффект. Для открытия
sheet отдельным evidence служит read-only oracle самой fixture. Изображения
просмотрены inline в задаче; локальный PNG-артефакт не заявляется.

## Текущий live blocker

После открытия sheet `get_state` не опубликовал его как отдельную owned surface:
`surfaces=[]`, хотя fixture подтверждала открытый диалог. Дальнейший ввод не
выполнялся. Source diagnosis: повторный AX element из `AXSheets` отбрасывался
как дубль ранее полученного элемента из `AXWindows`, вместе с exact owner proof.
Исправление collector/registry должно пройти live повтор до закрытия gate.

Primary AX сохраняет `complete=false` при ошибке optional description. API не
скрывает эту ошибку: `observe(mode:"both")` возвращает aggregate incompleteness,
а полное изображение может разрешить одно действие того же observation.
Pointer input отдельно требует image-ready и свежий Native point proof.

Ещё не подтверждены live: закрытие owned sheet, pointer/text/keyboard actions,
скрытие/сворачивание и точный show, отмена во время ввода, выбранный Chrome target.

## Что исправлено по результатам live

- Ошибки AX одного приложения не отзывают глобальные права.
- Capture, show и geometry используют доказательство точной цели вместо
  требования полной AX-инвентаризации всех приложений.
- ScreenCaptureKit output отсоединяется перед stop. Старый crash в
  `removeStreamOutput` после stop устранён; последующий live capture успешен.
- Native публикует и сохраняет проверенные readiness facts кадра; готовность
  чтения кадра не выдаёт разрешение ввода.
- `show_window` больше не запускает show и focus отдельными конкурирующими
  операциями. Частичный результат сохраняет исходную причину и operation ID.
- Installer сохраняет exact parent/helper witness до bootout. При update
  завершение Host было быстрым, но пятисекундное ожидание ухода процессов
  истекло. Повтор через durable recovery успешно завершил установку. Source
  `73cdebb` увеличивает bounded evidence polling до 60 секунд и сохраняет
  последний label/parent/helper state в ошибке; bootstrap до ухода старых
  процессов по-прежнему запрещён.

История подписи и разрешений:
[`startup-permissions-and-identity.md`](./startup-permissions-and-identity.md).

## Gates перед удалением старых исходников

| Gate | Статус |
| --- | --- |
| A02, A31 | Отдельные subprocess, private UDS/auth/lineage tests подтверждены (`f2a668e`, `6dfd0ae`) |
| A43 catalog/recovery | Новый installed runtime и 36 tools подтверждены; action acceptance остаётся частичной |
| Live capture/input | Capture, active probe и AXPress подтверждены; остальные действия перечислены выше |
| Старые listeners 7878–7882 | Собственные legacy services остановлены ранее; архивные процессы не затрагивались |
| Старый Chrome CDP LaunchAgent | Exact plist/job отсутствуют; уже работающий browser не остановлен |
| Reverse imports | Повторный source audit выполнен; Android tests мигрированы отдельно |
| Installer/source doctor | До удаления `input/bin` нужно убрать обязательную зависимость v2 installer от legacy parent directory, сохранив безопасный v1 rollback |
| Manifests/entrypoints/docs | Нужна одна согласованная migration/removal delta и обновление lockfile |

`scripts/legacy-source-removal-plan.json` остаётся планом, не фактом удаления.
`input/bin/meta-input-helper` является локальным ignored legacy artifact,
а не source-controlled helper установленного bundle. Нельзя удалять его
слепым `git rm` или затрагивать `computer-use.app` при очистке исходников.

Внешние REST consumers перечислены в [`../legacy-callers.md`](../legacy-callers.md).
Они требуют отдельной миграции в своих репозиториях; совместимость старого REST
с новым runtime не обещается. Их код в этой задаче не изменяется.
