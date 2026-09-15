# План поставки computer use без незакрытых обходных путей

Дата: 15 сентября 2026. **Проект реализации; этапы ниже ещё не выполнены.**
Основание: [ревью `bc4b6af`](reviews/2026-09-15-computer-use.md).
Контракты и архитектурные решения: [computer-use-architecture.md](computer-use-architecture.md).

## 1. Граница готовности

Обязательный результат — `desktop.core` и `browser.chrome` на Intel macOS 13.7.8.
`android.chrome` — отдельно проверяемый opt-in профиль; пока он не прошёл свой
этап, его инструменты не объявляются рабочими. Существующий Android код либо
проходит миграцию, либо отключается с видимой причиной. Нельзя оставить старый
автоматический bootstrap доступным рядом с безопасным desktop runtime.

Весь UI Android, private Spaces API, обход TCC/Secure Input и фоновые «always on
top» циклы не входят в desktop computer use. Это явная граница продукта, а не
список скрытых незавершённых обещаний. Если нужный сценарий внутри обязательной
границы не работает, релиз не считается завершённым.

## 2. Матрица возможностей

ID ниже — **проектные локальные capability IDs**. Это не существующий platform
inventory другого репозитория. Их должен реализовать registry ai-macos.

Обозначения текущего состояния: **частично** — есть путь с ограничениями;
**нет** — нет нужного end-to-end контракта; **REST** — есть внутренний маршрут,
но отсутствует direct MCP workflow; **ложный сигнал** — health не доказывает обещание.

| Capability ID | Сейчас | Целевой владелец | Проверяемый результат | Findings |
| --- | --- | --- | --- | --- |
| `runtime.identity` | Частично | runtime/native | host + login/runtime/native epochs + process incarnations | F01, F15 |
| `runtime.health` | Ложный сигнал | runtime | Loaded build IDs, protocol compatibility, permissions и reasons | F01, F10 |
| `runtime.install` | Частично | runtime/admin | Reproducible install, native build, atomic update, rollback | F01, F15 |
| `runtime.transport` | Нет | runtime | Private authenticated UDS; нет mutating public TCP | F06 |
| `runtime.arbitration` | Нет | runtime/native | Общий lease/fence между отдельными MCP clients | F02, F04 |
| `runtime.operations` | Нет | runtime/native | Request dedup, status, cancellation, drain, crash recovery | F03, F05 |
| `runtime.user-interference` | Нет | native/runtime | User takeover отзывает lease; unavailable observer обозначен | F04, F09 |
| `desktop.applications` | Нет | window/native | Приложения с окнами/без окон, hidden, AX errors | F07 |
| `desktop.application.lifecycle` | Нет | runtime/native | Resolve installed bundle, exact launch/quit, late completion и unsaved outcome | F07, F11 |
| `desktop.windows.all` | Нет | window/native | Все обнаруженные окна; incomplete/ambiguous не теряются | F07 |
| `desktop.window.identity` | Частично | native/window | Live ref, native generation, CG correlation evidence | F01, F07 |
| `desktop.window.show` | Нет | window/native | Exact unhide/unminimize/focus или честный unsupported | F07 |
| `desktop.window.lifecycle` | Частично | window | Focus/bounds/minimize/close, actual/partial, unsaved dialog | F11 |
| `desktop.displays` | Нет | native/window | IDs, global/usable bounds, scale/rotation/topology revision | F08, F11 |
| `desktop.ax` | Нет | native/window | Bounded tree, element refs, actions, owner relationships | F07, F16 |
| `capture.desktop` | Частично | screen/native | Caption, selected display/region, complete frame, transform | F08–F10 |
| `capture.window` | Частично | screen/native | Isolated/composite различены, metadata и ownership evidence | F08, F09 |
| `capture.observation` | Нет | runtime/screen | Receipt + freshness/target revision + bytes/pixel budget | F08 |
| `input.pointer` | Частично | input/native | Hover/click/right/double/scroll по observation и anchor | F04, F08 |
| `input.drag` | REST | input/native | Траектория, modifiers/button, bounded cancel/release | F05, F11 |
| `input.keyboard` | Частично | input/native | Text/key/shortcut, Unicode, preconditions и partial outcome | F03–F05 |
| `input.readiness` | Частично | native/runtime | Probe movement/readback/restore отдельно, без false permission result | F10 |
| `input.interaction` | Нет | runtime | Многошаговый focus session без закрытия popup между вызовами | F09, F16 |
| `input.clipboard` | Частично | input/runtime | Явный доступ, версия/лимиты, без содержимого в логах | F06, F16 |
| `browser.instances` | REST | chrome/runtime | Несколько профилей и browser epochs, provenance | F12, F16 |
| `browser.targets` | REST | chrome | Exact open/close/navigate/activate по instance + target | F12, F16 |
| `browser.observe` | REST | chrome/screen | CDP DOM/accessibility, bounded console, accurate capture | F12, F13 |
| `browser.readiness` | Частично | chrome | Strict/partial result и command/overall deadlines | F13 |
| `browser.resources` | Частично | chrome/runtime | Owned sessions/overrides/trace освобождаются, чужие сохраняются | F13, F15 |
| `android.chrome` | REST | android/runtime | Exact serial/transport/target, opt-in setup, owned forward | F14 |
| `mcp.catalog` | Частично | mcp/shared | Общие schemas/annotations, version negotiation, реальная доступность | F01, F16 |
| `diagnostics.receipts` | Частично | runtime | Operation traces без payload, bounded cache и recovery evidence | F03, F10, F16 |

## 3. Этапы реализации

Этапы идут в текущем canonical checkout и текущей ветке. Этот план не разрешает
самостоятельно создавать worktree/ветки, менять архивные процессы или публиковать
коммиты. В каждом этапе используются production paths, не story-only или
agent-local обходы.

### M0. Контракты и устранение непосредственных несоответствий

- Зафиксировать schema версии, typed errors, capability IDs и operation states из проекта.
- Закрыть wildcard bind/неаутентифицированные mutation входы; убрать mutating GET.
- Выключить autoInstall и общий ADB restart; убрать Android из стандартного desktop dev.
- В старом MCP health перестать выдавать unconditional stable-ID support; отдельно
  сообщать loaded/configured build и несовместимый backend.
- Добавить regression tests для F01/F06/F10/F14 на fake adapters.

**Выход:** ложная готовность и неявный bootstrap не маскируют состояние; старые
сервисы не становятся «готовым computer use» только после этих точечных исправлений.

### M1. Runtime, native broker, lifecycle

- Добавить runtime и native пакеты; вынести из MCP coordination/status/update.
- Долгоживущий native broker: framed protocol, request IDs, epochs/fences,
  operation registry, lease, cancellation, watchdog и held-input ledger.
- Один supervisor и startup lock, private socket, authenticated client/resumption.
- Импортировать window/input/screen модули вместо независимых REST peers.
- Реализовать healthy/degraded/quarantined состояния и `recover_input`.
- Завершить update/drain/rollback; сохранить проверенный helper path/TCC identity.

**Выход:** два разных процесса MCP не могут параллельно отправлять desktop input;
timeout не восстанавливает чужой фокус во время native dispatch; restart не
переигрывает незавершённые операции. Tests inject crash на каждом переходе.

### M2. Приложения, полная inventory и адресованный show

- NSWorkspace + AX + CG all inventory; ошибка одного приложения не скрывает остальные.
- Native registry с отдельными process/native generations; optional CG correlation.
- Полная иерархия window/sheet/popup, состояния/доступные действия/unknown.
- `list_applications`, `list_windows`, `list_displays`, `show_window`,
  verified focus/bounds/minimize/close и bounded AX read/actions.
- Raw pid/CG selector допускается только из свежего inventory; legacy index/title
  не участвуют в native mutation identity.

**Выход:** исходный сценарий Chrome получает объяснимый inventory и show именно
выбранного существующего окна либо конкретное ограничение OS с evidence.
Другой профиль, новая вкладка или похожее окно не используются как замена.

### M3. Capture и observation contract

- Native SCStream на Mac 13.x: complete frame, explicit dimensions, filter,
  per-display metadata, bounded stop и health собственного Screen Recording grant.
- Display composite отдельно от isolated window, без скрытого focus/raise.
- Observation registry, regions/transforms, freshness, topology revision,
  cursor/clip/occlusion/ownership, byte/pixel limits.
- Прикладной verification capture обновляет тот же session-scoped latest cache.
- Удалить двойной scale и неверный Buffer view path, обеспечить caption round-trip.

**Выход:** конкретный image pixel однозначно преобразуется в нужную область
экрана/браузера, stale/неподтверждённая область не допускает click. Native SCK
capability объявляется после проверки именно на Intel 13.7.8, не по SDK import.

### M4. Завершённые desktop workflows

- Ввод по target+observation/AX ref, проверки в native перед каждым cluster.
- Bounded interaction session с Cmd+L/type/Enter и Save/Open без лишнего restore.
- Hover, несколько типов click, anchor scroll, trajectory drag, Unicode text,
  modifiers, cancel/status и подтверждённый cleanup.
- System surfaces для Dock/menu; launch/quit отдельно от show/close-window.
- User-interference policy и one-shot режим при unavailable observer.

**Выход:** редактирование текста, меню, системные диалоги, drag в canvas,
несколько мониторов и вмешательство человека закрыты живыми сценариями.
Скриншот проверяется на результат, а не только на наличие PNG.

### M5. Chrome как самостоятельный adapter

- Browser instance/profile registry; exact target identity и reconnect epochs.
- Direct MCP инструменты для tab lifecycle/navigation, DOM/browser AX,
  screenshot, console, bounded waits; без URL matching и скрытых AppleScript переходов.
- Deadlines/typed subscriptions в CDP transport; строгие readiness predicates.
- Leases для target, browser-wide trace и runtime-owned overrides; page activation
  с видимым side effect координируется с desktop lane.

**Выход:** несколько профилей/одинаковых URL, restart и закрытый target не
подменяются; зависший browser command завершается контролируемо. Storybook остаётся
у собственного MCP/процесса; обычный Chrome smoke использует отдельный разрешённый fixture target.

### M6. Android: миграция или явно недоступный профиль

- Установка ADB — отдельный MacPorts workflow с проверкой port/variant; runtime
  не устанавливает пакеты и не открывает prompt.
- Serial/transport epoch/owned forward; никаких first-device и tabs[0] fallback.
- Exact target creation, measured full-page capture, bounded reload/context waits.
- Disconnect/multiple devices не переходят на desktop Chrome. Cleanup удаляет
  только собственные forwards и сохраняет общий ADB daemon.

**Выход:** `android.chrome` принят отдельной device matrix. Если устройства для
приёмки нет, capability остаётся недоступной с причиной; desktop релиз явно
не заявляет Android поддержку. Старый Android bootstrap всё равно закрыт в M0.

### M7. Завершение миграции и приёмка

- Предлагаемая последовательность версий: `0.4.x` — переход с учётом клиентов;
  `1.0.0` — только целевой контракт. Эти номера — план, не назначенный релиз.
- Перед удалением составить inventory callers: repo CLI/.http, MCP config,
  skills и явно названные актуальные потребители внутри canonical repositories.
  Архивный `/Users/zavx0z/production` не сканировать и не мигрировать.
- Перевести поддерживаемые callers на runtime; неизвестный blocker регистрируется
  с владельцем и сценарием, а не обходится вечной совместимостью.
- Удалить legacy REST servers/selector mutation paths, независимые restore/mutex,
  URL-based CDP matching и deprecated connector routing.
- Обновить API docs/skill/AGENTS/examples из общих схем; проверить текущий
  MCP-каталог в настоящей задаче после подключений/обновления.
- Native code, API docs, compiled build, capabilities и evidence относятся к
  одному комплекту; mixed generation не допускает mutation.

**Выход:** нет второго неуправляемого пути ввода, неизвестных работающих
собственных старых сервисов и объявленных без доказательств возможностей.
Архивные/чужие процессы сохраняются и явно исключаются из владения runtime.

## 4. Матрица приёмки

Каждая строка получает evidence record: build IDs, OS/arch, сценарий,
requested/actual target, operation/observation IDs, ожидаемый и фактический
результат, cleanup outcome. Для visual сценария нужен просмотр кадра и результата
в приложении; зелёного HTTP ответа недостаточно.

| ID | Сценарий | Обязательный результат | Уровень |
| --- | --- | --- | --- |
| A01 | Новый MCP поверх старого native/backend | `backend-version-mismatch`, dependent actions недоступны | Contract + live |
| A02 | Два MCP процесса запускаются одновременно | Один runtime/helper; чужой listener не заменён | Integration |
| A03 | Два независимых клиента отправляют input | Не более одной активной desktop dispatch; stale queued coordinates не исполняются | Integration |
| A04 | Focus steal между preflight и native step | Конфликт до следующей отправки; при уже отправленном событии partial/unknown | Fault injection + live |
| A05 | Долгий dispatch и timeout MCP | Фокус/lease не отданы другому действию до stop/quarantine | Integration |
| A06 | Cancel до первого события | `dispatch:none`, ни одного события в test sink | Native fixture |
| A07 | Cancel после каждого synthetic down | При живом helper bounded matching up; после stop ACK новых событий операции нет | Native fixture + live |
| A08 | Helper SIGKILL между down и ledger ACK | `cleanup:unknown`, input quarantine, явный recovery; нет blind replay/up | Fault injection |
| A09 | Runtime crash при живом helper | Helper watchdog останавливает будущие events; ledger и cleanup видимы после reconnect | Fault injection |
| A10 | Старый fence после runtime/helper restart | Отказ по epoch/generation, даже при том же counter/PID | Native fixture |
| A11 | Reply потерян, клиент повторяет request ID | Возвращается прежняя операция, payload mismatch отклонён | Contract |
| A12 | Человек работает во время interaction | User takeover отзывает lease; старый focus автоматически не восстанавливается | Live |
| A13 | Event observer unavailable/revoked | Health degraded, one-shot/no extension, restore не предполагает отсутствие человека | Contract + live |
| A14 | Hidden/minimized/offscreen/other-Space window | Запись inventory с известными/unknown состояниями; exact show или конкретная невозможность | Live |
| A15 | Процесс без окон / AX timeout / denied AX | Три различимых ответа; incomplete не выдаётся за complete empty | Contract + live |
| A16 | Одинаковые title/frame/PID окна | Неоднозначность CG↔AX не скрыта; никакого first-match | Native fixture + live |
| A17 | PID/CG ID reuse и window close/reopen | Старый ref не адресует новый экземпляр | Native fixture |
| A18 | AX-only окно без CG link | AX capability отделена от capture/pointer; не придумывается CG ID | Native fixture + live |
| A19 | Sheet + popup, закрытие Save/Open | Подтверждён owner; закрытый sheet не восстанавливается как top-level окно | Live |
| A20 | Cmd+L → text → Enter | Поле не теряет focus из-за межшагового restore; нужный target/URL проверены | Live |
| A21 | Visible composite с чужим/прозрачным overlay | Receipt не выдаёт bounds intersection за ownership; неподтверждённый point не clickable | Native fixture + live |
| A22 | Isolated window, скрытый/защищённый контент | Указаны excluded auxiliary surfaces и freshness; blank/stale не объявлен новым кадром | Live |
| A23 | Retina + обычный дисплей слева/сверху, rotation | Корректные transforms, отрицательные origins, round-trip ошибка ≤1 logical point | Native fixture + live |
| A24 | Window spans displays, разное время кадров | Per-region timestamps/skew; input использует свежий region | Live |
| A25 | Move/resize/display disconnect после capture | Observation stale, действие отклонено до отправки | Fault injection + live |
| A26 | SCStream first/idle/blank frame и stop timeout | Только complete frame новый; stop timeout имеет cleanup outcome | Native fixture + live |
| A27 | Emoji/составные символы, RU/EN, modifiers | Точный текст в fixture; cancel не продолжает оставшиеся clusters | Live |
| A28 | Вложенные scroll panes, slider/canvas drag | Указанный anchor/trajectory; результат в нужном элементе | Live |
| A29 | Move success, resize fail | Partial с actual bounds, а не общий ok | Contract + live |
| A30 | Unsaved close/quit | Новая modal state; auto-discard/повторного close нет | Live |
| A31 | Wildcard/LAN/cross-user/forged socket token | Нет public mutation listener; unauthorized запрос не достигает executor | Integration |
| A32 | Screen Recording/Accessibility grant утрачен | Пассивная диагностика, exact helper path, отсутствие auto Settings/request | Contract + live |
| A33 | Helper update меняет подпись/Screen Recording owner | Permission state проверяется заново; failure/rollback без ложного success | Installation live |
| A34 | Одинаковые URLs в разных Chrome profiles | Exact instance/target сохраняется; отсутствие target не допускает fallback | Contract + live |
| A35 | Navigation с already-inflight network и reflow >2.5s | Strict ready не возвращает false success; partial отдельно и явно | Browser fixture |
| A36 | Browser command/WS/trace hangs или disconnect | Общий deadline; bounded cleanup; чужие overrides не сброшены | Browser fixture |
| A37 | Huge full-page/viewport | Pixel/byte/dimension cap до дорогого выделения памяти | Contract |
| A38 | Desktop без Chrome, Android отключён | Core работает; optional readiness отдельно | Integration |
| A39 | Два телефона / USB reconnect / forward занят | Явный serial + epoch, нет первого устройства/desktop target, чужие forwards сохранены | Device live |
| A40 | Android new target/full-page/reload | Exact created target, measured clip, bounded context wait | Device fixture + live |
| A41 | Capture после action и PiP/latest | Тот же observation/caption/frame ID, cache scoped к клиенту | Contract |
| A42 | Отключение клиента/истечение lease/журнал заполнен | Bounded cleanup/retention, unresolved operations сохранены, payload отсутствует в логах | Fault injection |
| A43 | MCP reconnect/tools list changed | Инструменты доступны именно в настоящей задаче; standalone test отдельно | Client live |
| A44 | Sleep/wake, lock screen, смена login session | Старые leases/наблюдения отозваны, queued ввод не попадает в login screen | Native fixture + live |
| A45 | Slow AX app одновременно с cancel/health | Control loop остаётся доступен, deadline даёт partial inventory; второй helper не запускается | Fault injection |

## 5. Начальные budgets и их проверка

Числа ниже — стартовые проектные лимиты, не измеренные latency promises.
Превышение даёт явный timeout/partial, не считается success. Корректировка
делается по измерениям на Intel Mac и фиксируется в capability profile.

| Ресурс | Начальный предел |
| --- | --- |
| AX single request | 500 мс; общий inventory budget 5 с с partial response по истечении |
| Click/key/short native sequence | 5 с общего deadline, native checkpoints до каждого шага |
| Typing | 30 с, 10 000 UTF-16 units на запрос; фактические chunks и попытки отдельно |
| Native cancel / stream stop | 1 с на graceful stop; дальше cleanup unknown/quarantine, не silent release |
| Capture | 10 с, 32 мегапикселя, 64 МиБ encoded; большой desktop разбивается на regions |
| Interaction | Idle до 30 с, общий срок до 120 с, продление только с ready observer |
| Browser command / full wait | 5 с на command, до 30 с на общий wait; explicit profile для длинной диагностики |
| Trace / event buffer | До 10 с и 32 МиБ; обычный console buffer до 1 000 событий/1 МиБ, дальше truncation marker |
| AX tree | Depth 12, до 1 500 nodes/1 МиБ на page, pagination; secure values исключены |
| Capture cache | TTL 120 с, до 4 кадров/128 МиБ на client principal, 512 МиБ суммарно; eviction только завершённых наблюдений |
| Operation journal | Terminal metadata до 24 ч/10 000 записей; unresolved не удаляются, после 100 unresolved запрещён приём новых mutations |
| Client/resumption credentials | Файл `0600`, активный token до epoch change; resumption до 24 ч, отзыв/ротация при recovery и admin update |

Эти defaults переносятся в schema M0 и проверяются на bounded memory/latency.
При expiry idempotency journal старый request ID возвращает `receipt-expired`,
а не запускается как новое действие: epoch/expiry являются частью client key.
Не вводить бесконечные значения через `null timeout` как постоянный контракт.

## 6. Перечень удаления старых путей

| Текущий путь | Замена | Когда перестаёт существовать |
| --- | --- | --- |
| 4 detached REST service starts из MCP launcher | Один runtime supervisor и native child | M1 + M7 |
| `desktopMutationActive` как correctness lock | Shared runtime/native fence | M1 |
| Native input без target/operation/fence | Broker executor envelope | M1/M4 |
| Mutation по title/index/frame, legacy modal containment | Fresh ref/owner evidence | M2, окончательно M7 |
| Screen/Chrome/MCP самостоятельные restore | Runtime interaction owner | M3/M4 |
| Screen Chrome proxy и Chrome UI duplicate capture/scale | Общий native capture; CDP viewport отдельно | M3/M5 |
| URL→CDP profile/window matching | Browser instance + target | M5 |
| Generic raw CDP/eval как незаметный fallback | Отдельный diagnostic scope либо отсутствие в агентском каталоге | M5/M7 |
| Android autoInstall, first device/tab, kill-server | Explicit setup + serial/transport/target | M0/M6 |
| Open peer REST и старые CLI-обходы coordinator | Private runtime API | M0/M7 |
| Pin interval без сроков и ownership | Не входит в core; удалить после inventory callers | M7 |
| Ручные divergent tool/API описания | Schemas + generated reference + короткий workflow skill | M7 |

Каждому оставшемуся файлу/маршруту из таблицы перед финальным cutover назначается
решение: migrated, removed или explicitly disabled. «Пока используется где-то»
без установленного caller и срока не является состоянием завершения.

## 7. Definition of done

1. Все обязательные capabilities из матрицы реализованы по целевому контракту,
   либо явное OS-ограничение находится вне обещанного сценария и возвращается
   проверяемым результатом. Нельзя исключить failing основной сценарий ради релиза.
2. Все P1/P2 из ревью имеют implementation/test evidence или удалённый старый путь.
3. Существующие unit tests, новые contract/fault tests и необходимые native live
   проверки прошли; mechanical checks отдельно от visual acceptance.
4. Полный сценарий «найти и показать существующее окно нужного Chrome» проверен
   с hidden/minimized/multiple-profile вариантами на этом Mac.
5. Связка discovery → show → observation → input → outcome → recovery не требует
   от агента REST, AppleScript, shell input, AppShot или подмены target.
6. После cancelled/finished нет оставленных runtime-owned sockets, helper
   operations, streams, pending CDP calls, overrides, forwards или pin loops.
   При неизвестном cleanup оно явно блокирует опасное продолжение и имеет recovery.
7. Повторное подключение Codex подтверждено настоящим tool call из задачи;
   skill, MCP schema, runtime и native принадлежат совместимому build.
8. Финальный отчёт содержит реализованное, проверенное, реальные ограничения и
   точные доказательства; наличие этих проектных документов не заменяет реализацию.
