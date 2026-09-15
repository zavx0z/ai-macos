# Готовность установленного computer-use и удаления legacy source

Срез ведущего: 16 сентября 2026 года. Source checks, установленная сборка и
реальные действия проверяются отдельно. Зелёные unit tests не закрывают live gates.

## Установленная версия

Последний подтверждённый installed checkpoint — source `c9951df`, release
`release-97510f3e15d016dda8ac7402`, runtime/native build suffix
`f21decdba11f01ccff5be296`. Последующие коммиты требуют новой установки.

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

Основные receipts успешных действий на предыдущем installed `990e548`:

- input readiness: `operation:12f644c5-2939-4c56-8dc7-f398242bd564`;
- AXPress: `operation:95dc9286-c8ae-4bb1-ac1a-e98c80b4625b`;
- runtime epoch: `runtime:41f8691f-ed6b-44d1-9e70-4fabe86c3594`;
- Native generation: `native-A61E58EC-E567-4350-85DE-03BD421C7661`.

Receipt `effect: unverified` сам по себе не подтверждает эффект. Для открытия
sheet отдельным evidence служит read-only oracle самой fixture. Изображения
просмотрены inline в задаче; локальный PNG-артефакт не заявляется.

## Текущий live blocker

После открытия sheet `get_state` не опубликовал его как отдельную owned surface.
Source `0e486d7` исправляет потерю exact AXSheets owner при дедупликации и уже
установлен. После обновления пользователь подтвердил переключение на другой
macOS Space. Первый scoped `get_state(pid)` вернул только CG-only records;
повторный — одно AX окно при `axStatus: timed-out`. Sheet не выбран, ввод не
выполнялся. Это не доказывает regression sheet patch.

Проверка source обнаружила scheduling flaw: `list_windows` применяет app/pid
фильтр после полного Native опроса. Foreground получает первый бюджет, а
явно выбранное фоновое приложение конкурирует с примерно 95 приложениями за
общий deadline. Исправление должно передавать scheduling hint и при первичном
поиске, и при fresh re-resolution уже выданной цели, сохраняя exact incarnation
proof и честную completeness. Переключение Space или фокуса не является обходом.

Дополнительно `ae4a4af` исправляет диагностический `axWindowCount`: теперь это
число опубликованных AX окон, а не общий application.windowCount, включавший
CG-only records. Прежнее значение 6 не доказывало наличие шести AX окон.

Primary AX сохраняет `complete=false` при ошибке optional description. API не
скрывает эту ошибку: `observe(mode:"both")` возвращает aggregate incompleteness,
а полное изображение может разрешить одно действие того же observation.
Pointer input отдельно требует image-ready и свежий Native point proof.

Ещё не подтверждены live: закрытие owned sheet, pointer/text/keyboard actions,
скрытие/сворачивание и точный show, отмена во время ввода, выбранный Chrome target.

## Проверки исходников

Последний общий safe прогон: 865 pass, 1 skip, 0 fail; 3659 assertions,
144 files. System clipboard live test отключён. Последующие изменения требуют
собственных targeted checks и проверки новой установленной сборки.

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
| Installer/source doctor | `c9951df`: v2 не требует legacy parent; v1 recovery сохраняет strict write gate и journal при отсутствующем trusted parent |
| Manifests/entrypoints/docs | Нужна одна согласованная migration/removal delta и обновление lockfile |

`scripts/legacy-source-removal-plan.json` остаётся планом, не фактом удаления.
`input/bin/meta-input-helper` является локальным ignored legacy artifact,
а не source-controlled helper установленного bundle. Нельзя удалять его
слепым `git rm` или затрагивать `computer-use.app` при очистке исходников.

Внешние REST consumers перечислены в [`../legacy-callers.md`](../legacy-callers.md).
Они требуют отдельной миграции в своих репозиториях; совместимость старого REST
с новым runtime не обещается. Их код в этой задаче не изменяется.
