# Готовность установленного computer-use и удаления legacy source

Срез ведущего: 16 сентября 2026 года. Source checks, установленная сборка и
реальные действия проверяются отдельно. Зелёные unit tests не закрывают live gates.

## Установленная версия

Последний подтверждённый installed checkpoint — source `61d1e9d`, release
`release-a1308ceda1755e5b96464c6a`, runtime/native build suffix
`47a1c96c07f1223d1fbf6e13`. Doctor подтвердил четыре grants, ready observer,
ноль active operations и quarantined resources. Последующие коммиты требуют
новой установки.

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
Все desktop-действия выполняет direct ai-macos MCP. Первые проверки выполнены
в задаче «Computer use: финальная проверка установленной версии», numeric input
продолжает задача «Computer use: ввод и финальный прогон».

| Проверка | Наблюдаемый результат |
| --- | --- |
| Два одинаковых заголовка | Primary и secondary различаются точными AX identifiers и refs |
| AX | Возвращаются RU/EN/emoji/composed text, slider value, parent relationships и нулевые frame невидимых элементов |
| Снимок primary | Получен и просмотрен PNG 280×234; содержание соответствует fixture, cleanup complete, Native generation не изменилась |
| `check_input` | Move и restore posted/observed/readback confirmed, cursor восстановлен, cleanup complete |
| `show_window` | Одна операция show успешно возвращает точное окно; ошибочного второго focus и malformed wrapper больше нет |
| AXPress `fixture.sheet.open` | Одна операция completed, exact target verified, cleanup complete; oracle подтвердил `sheet-opened` и `sheet.open=1` |
| Поиск после переключения Space | `a34dd4b`: scoped PID снова возвращает оба точных AX окна; unrelated apps сохраняют честную global incompleteness |
| Отдельный sheet и закрытие | `70eec77`: отдельный surface target с ownerTargetId, AX complete; один AXPress close, oracle `sheet-closed`, `sheet.open=0` |

Основные receipts успешных действий на предыдущем installed `990e548`:

- input readiness: `operation:12f644c5-2939-4c56-8dc7-f398242bd564`;
- AXPress: `operation:95dc9286-c8ae-4bb1-ac1a-e98c80b4625b`;
- runtime epoch: `runtime:41f8691f-ed6b-44d1-9e70-4fabe86c3594`;
- Native generation: `native-A61E58EC-E567-4350-85DE-03BD421C7661`.

Receipt `effect: unverified` сам по себе не подтверждает эффект. Для открытия
sheet отдельным evidence служит read-only oracle самой fixture. Изображения
просмотрены inline в задаче; локальный PNG-артефакт не заявляется.

## Текущий live blocker

Поиск background windows и sheet уже исправлены и проверены. `a34dd4b`
передаёт scheduling priority через первый app/PID поиск и fresh re-resolution
applicationRef. `70eec77` дополнительно обнаруживает direct AXChildren sheet
по роли, PID и exact AXParent, когда AXSheets не дал owner. Это подтвердили
полная AX hierarchy fixture, отдельный surface и реальное закрытие диалога.

Первый numeric pointer click выявил исправленный в `ecc12c8` blocker:
`input_executor.m` требует равенства observation.inventoryRevision и current
operation.inventoryRevision. Реальный допустимый путь имел capture revision 10
и свежий target revision 11. Настоящий TS producer → C command loop с fake sink
воспроизводит отказ до begin и отсутствие физических posts. Исправление
сохраняет независимые проверки capture proof, текущей цели, layout и геометрии.
Valid outer context с rejected plan теперь получает реальный terminal receipt
без posts, а unknown status не завершает Native actor.

Live operation `operation:485a50d3-003b-44ce-97fa-8f48f840bd5a` осталась failed
с dispatch/effect unknown; после запроса статуса Native завершился code 65.
Managed restart сохранил evidence и закрыл admission. Один штатный пассивный
`recover_startup_input` подтвердил ALL-UP: resolved=1, unresolved=0,
remainingOperations=0, admissionSealed=false, cleanup=complete/resources released.
Это не меняет исторический unknown dispatch и не разрешает слепой replay.
Следующая попытка была выполнена только после установки и нового observation.

На installed `ecc12c8` operation
`operation:d41644b0-34af-4e53-9fbd-525758875fb6` завершилась failed с тремя
post attempts, partial dispatch и `userInterference: observed`. Cleanup complete,
ресурсы освобождены, Native не перезапускался. Пользователь подтвердил отсутствие
физического ввода; повтор не выполнялся. Последующий read-only снимок показал
неизменённое поле, но сам по себе не доказывает отсутствие эффекта клика.

`b8c160a` разделяет physical input, UI invalidation и lifecycle changes. Только
собственный single click после mouse-down может принять focus exact target или
подтверждённого owner/surface; физическое вмешательство остаётся причиной отмены.
Добавлена ограниченная диагностика первого решения observer без содержимого окон.
`b45b548` сохраняет typed error и настоящий operation ID в коротком API.
Оба исправления установлены в `61d1e9d`. Новая операция
`operation:9df26cbb-0ed0-48d2-b4de-50522a4cdf85` честно сообщает cancelled,
partial dispatch, `userInterference: none-observed`, cleanup complete, resources
released. Observer diagnostic: `ui-invalidation`, `eventKind: focus`,
`targetRelation: missing`, own input armed, phase 3. Физическое вмешательство
больше не заявляется, но потеря exact target у focus пока блокирует приёмку.
Повтора не было; read-only oracle подтвердил неизменённое поле, закрытый sheet,
оба окна visible. Следующее исправление не должно разрешать targetless focus.

Проверочная задача с новым каталогом:
«Computer use: ввод и финальный прогон». Предыдущая задача сохранила старое
`Array<string>` представление numeric tuple. `3db57a4` публикует обычный
числовой array с minItems=maxItems=2; установленный MCP и свежая задача это
подтвердили. `d0ac887` обнаруживает изменение схем даже при совпавшей revision.
`ae4a4af` считает в axWindowCount только опубликованные AX окна, без CG-only.

Primary AX сохраняет `complete=false` при ошибке optional description. API не
скрывает эту ошибку: `observe(mode:"both")` возвращает aggregate incompleteness,
а полное изображение может разрешить одно действие того же observation.
Pointer input отдельно требует image-ready и свежий Native point proof.

Ещё не подтверждены live: успешные pointer/text/keyboard actions,
скрытие/сворачивание и точный show, отмена во время ввода. Инвентаризация
настроенного Chrome-CDP дала пять отдельных target IDs; страницы не менялись.

## Проверки исходников

Последний общий safe прогон на `61d1e9d`: 879 pass, 1 skip, 1 fail;
3728 assertions, 145 files. System clipboard live test отключён. Единственное
падение: `screen/tests/adapter.test.ts`, bounded wait — 15 ms deadline истёк
до admission под нагрузкой, получен `deadline-exceeded` вместо ожидаемого
post-admission `operation-outcome-unknown`. Требуется детерминированная проверка
этой границы; весь прогон не считается зелёным.

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
  процессов по-прежнему запрещён. `61d1e9d` допускает смену command в процессе
  завершения, считая прежний PID + birth по-прежнему живым. До bootout exact
  command ownership остаётся обязательным. 66 installer/admin tests подтвердили
  transient exit, timeout, PID reuse и совместимость durable witness; реальная
  установка `61d1e9d` успешно прошла эту границу.

История подписи и разрешений:
[`startup-permissions-and-identity.md`](./startup-permissions-and-identity.md).

## Gates перед удалением старых исходников

| Gate | Статус |
| --- | --- |
| A02, A31 | Отдельные subprocess, private UDS/auth/lineage tests подтверждены (`f2a668e`, `6dfd0ae`) |
| A43 catalog/recovery | Новый installed runtime и 36 tools подтверждены; action acceptance остаётся частичной |
| Live capture/input | Capture, active probe, AXPress и separate sheet close подтверждены; pointer blocker и остальные действия перечислены выше |
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
