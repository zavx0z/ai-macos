# Целостное ревью ai-macos перед продолжением реализации

После завершения ревью Владимир поручил перенести отчёт в корень репозитория
и выполнить commit/push. Исходные изменения сохранены отдельными коммитами:
`167309c` — WIP observer merge APIs без broker integration;
`c9ce2a4` — детерминизация deadline-теста Screen. Упоминания незакоммиченных
изменений ниже относятся к исходному срезу ревью. Фиксация WIP не означает
принятия его как законченного исправления.

Дата: 16 сентября 2026. Проверенный checkout: `main`,
`40b1b822baa47d74e24eb1d91546e8f525eaaa9a`.
Приоритет P1 означает препятствие надёжному выпуску; P2 — обязательную работу
по соответствующему сценарию. Ни одно замечание не означает, что описанный
неблагоприятный эффект уже произошёл на компьютере Владимира.

## 1. Подтверждённые findings по серьёзности

### R01 · P1 · Параллельные запросы observer могут завершить единственный Native broker

**Trigger:** два клиента одновременно выполняют `observe` либо два наблюдения
одного клиента доходят до проверки coverage. Запросы чтения не занимают общий
desktop-input lease.

**Код:** `runtime/src/observer-hub.ts:169–194` отправляет каждый coverage request
отдельно, без общей очереди или объединения одновременных чтений.
`native/src/adapter.ts:449–462` также сразу выполняет exchange.
`native/src/command_loop.m:298–305` при `_observerCommandPending` вызывает
`shutdown:65`, вместо очереди или обычного busy-ответа. Флаг остаётся установлен
на время асинхронного `maintenance` (`command_loop.m:211–235`).

**Последствие:** корректная конкуренция пассивных запросов становится fatal
protocol violation, отзывает capabilities и может потребовать recovery операций.
Это противоречит архитектуре одного Runtime для нескольких MCP-клиентов.

**Проверка:** изолированный вызов настоящего `RuntimeNativeObserverHub` с
управляемым Native boundary дал `maximumNativeRequests: 2` для двух
одновременных `coverage()`. Fatal-ветка подтверждена исходником Native;
реальный установленный broker таким запросом не испытывался.

**Исправление:** единая политика конкурентности observer control на границе
Runtime/Native; проверка двух настоящих запросов через production command loop.
Штатное пересечение чтений не должно завершать процесс.

### R02 · P1 · Запоздавший coverage snapshot ошибочно превращается в необратимый gap

**Trigger:** Native снял coverage с `nextSequence=N`; до обработки ответа Runtime
уже принял корректный PUSH события N. В Native snapshot производится в action
queue, ответ публикуется позже в control queue; отдельный timer публикует PUSH
(`native/src/command_loop.m:211–235, 302–316, 591–593`). Общего барьера для
снимка и его доставки нет.

**Код:** `runtime/src/observer-hub.ts:203–204` сравнивает ответ с уже продвинутым
локальным cursor и вызывает `#markGap`. `observer-hub.ts:342–350` навсегда
останавливает reader/subscribers. `runtime/src/host.ts:562–567` закрывает
view guard и отзывает готовность действий.

**Последствие:** допустимый порядок доставки ошибочно считается потерей событий.
Новый `observe` не исправляет уже закрытый guard. Сам по себе этот случай не
доказывает настоящую потерю continuity.

**Проверка:** настоящий Hub, сохранённый ответ с sequence 1, затем принятие PUSH
sequence 1 и возврат ответа: `state: unavailable`, `gapDetected: true`, причина
`Native observer coverage отстаёт от уже принятой sequence`. Системные события
не отправлялись.

**Исправление:** различать исторический согласованный watermark, неполученный
хвост и доказанное противоречие истории. Сохранить строгие проверки generation,
instance, пропусков sequence и реального overflow.

### R03 · P1 · Observer и текущая inventory расходятся в личности доступных окон

**Trigger:** приложение/окно отсутствовало в startup index из-за AX timeout,
другого Space либо появилось позднее; затем scoped inventory успешно его нашла.

**Код:** `native/src/broker_main.m:644–699` строит index при observer prepare и
замыкает его в resolver. Обычная inventory в `broker_main.m:513–521` обновляет
`MetaMacOSBackend`, но не индекс observer. `meta_observer_target_index.m:333–340`
отвергает неизвестный process incarnation; ancestry в строках 145–218 может
разрешить только уже известные записи. Новые merge-методы существуют только в
незакоммиченном черновике и не имеют production caller.

**Последствие:** target пригоден для show/capture/hit proof, но callback фокуса
не получает тот же exact target. `meta_observer_command.m:813–818` не может
признать такой focus допустимой реакцией собственного клика: получается
`ui-invalidation`, операция останавливается с partial dispatch.

**Доказательность:** конфликт жизненных циклов подтверждён кодом. Он согласуется
с классом последнего live-отказа, но **не доказывает причину именно той операции**.
Для неё не установлено, какого AX callback/элемента не хватило resolver.

**Исправление:** один authoritative lifecycle target registry и производный
observer index с явной revision, закрытием/заменой целей и частичной inventory.
Просто разрешить targetless focus нельзя. Оценка черновика — в разделе 6.

### R04 · P1 · Chrome AX пропускает узлы и сообщает, что дерево не усечено

**Trigger:** корень AX имеет непосредственного ребёнка-кнопку.

**Код:** `chrome/src/adapter.ts:477–490` кладёт в очередь `root.childIds`, а
затем вызывает `Accessibility.getChildAXNodes` уже для каждого ребёнка. В
Chromium этот метод добавляет **детей запрошенного узла**, а не сам узел:
[реализация Chromium, getChildAXNodes / AddChildren](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/accessibility/inspector_accessibility_agent.cc#L305).
Таким образом прямой ребёнок не попадает в результат; на более глубоком дереве
пропускаются уровни. Fake в `chrome/tests/cdp-driver.spec.ts:21–24` возвращает
сам `child` на любой такой запрос и маскирует ошибку.

**Последствие:** `observe(mode: ax)` может выглядеть полным, хотя кнопки и поля
отсутствуют. Уменьшение payload в сравнении API тогда достигается потерей данных.

**Проверка:** production `CdpBrowserDriver` через локальный тестовый WebSocket
с деревом `root → button` вернул только `root`, `nodeCount: 1`,
`truncated: false`; отправленный ID был `button`. Реальный Chrome не менялся.
Существующий тест при этом проходит.

**Исправление:** обходить детей уже опубликованного родителя, контролировать
уникальность, связи и budgets; тестировать fake, повторяющий семантику Chromium,
и сверить дерево с реальной fixture page.

### R05 · P1 · Профиль Chrome декларируется конфигурацией, но не проверяется на endpoint

**Trigger:** неверный порт в конфигурации либо перезапуск Chrome с другим
профилем на прежнем порту. Это возможно без совпадения URL или подделки target ID.

**Код:** `runtime/src/browser-config.ts:7–12` принимает `profilePath` и endpoint.
`runtime/src/browser-host.ts:84–95` создаёт driver только из host/port;
profilePath переносится в provenance и fingerprint.
`chrome/src/adapter.ts:379–386` при connect проверяет только `/json/version`
и строку Browser; постоянного соединения здесь нет. Дальнейший `listTargets`
повторно читает endpoint. Production JSON config не связывает его с проверенным
PID/start-time либо browser process incarnation.

**Последствие:** точные handles изолированы внутри объявленного instance, но
не доказывают соответствие реального процесса заявленному профилю. Можно
читать и изменять вкладку другого профиля под прежней меткой. Current transport
generation также не гарантирует обнаружение бесшовной замены endpoint.

**Доказательность:** отсутствие проверки подтверждено producer→driver путём.
Неверный профиль в текущей установленной конфигурации не установлен.

**Исправление:** проверяемая связь endpoint с реальным экземпляром browser и
профилем, инвалидация при замене; если это не удаётся доказать, статус должен
говорить «configured, identity unverified». Live-сравнение одинаковых URL
должно проверять разные процессы/профили, а не только разные строки handles.

### R06 · P1 · Durable journal исчерпывается за время жизни login session

**Trigger:** накоплено 10 000 operation files, в том числе завершённых с
подтверждённой очисткой. Captures/readiness также создают Core operations.

**Код:** `runtime/src/host.ts:98–100` хранит журнал в каталоге login session,
общем для runtime restarts. `runtime/src/storage/common.ts:15, 77–86`
отказывает при достижении 10 000 файлов. `operation-journal.ts:63–73, 123`
не имеет prune/compact API; реализации удаления завершённых записей нет.
`runtime/src/core.ts:170–171, 769–770, 1295–1301` также удерживает terminal
records/results в памяти. Ошибка обязательной записи ведёт к закрытому admission
через failure path Core.

**Последствие:** штатная длительная эксплуатация заканчивается отказом
новых операций; обычный runtime restart не освобождает файловую ёмкость.
Документированный предел «24 часа / 10 000 terminal metadata»
(`docs/computer-use-delivery.md:308–317`) не реализован как retention policy.

**Доказательность:** source finding; 10 000 файлов в пользовательском state
не создавались. Необходима изолированная проверка ёмкости и рестарта.

**Исправление:** bounded terminal retention с сохранением unresolved evidence,
receipt-expired/dedup tombstones и безопасной компактацией. Не удалять журнал
пользователя как способ продолжить приёмку.

### R07 · P2 · Короткий API блокирует цель после 128 действий или локальных отказов за сутки

**Trigger:** 129-й `runTrackedMutation` на тот же handle, пока история первых
128 записей моложе суток. Даже отказы до Core admission занимают место.

**Код:** `runtime/src/agent-operations.ts:118–121, 158–160, 379–392`.
`runtime/src/agent-targets.ts:209–235` при refresh возвращает тот же handle;
обычный `get_state` предел не сбрасывает. Status показывает только 64 recent.

**Проверка:** настоящий `AgentOperations` + `AgentTargetRegistry`, 129 попыток
с локальным отказом handler: handler вызван 128 раз, последняя ошибка
`Agent operation retention capacity исчерпана`; refresh сохранил handle,
status вернул 64 recent. Никаких Native действий не было.

**Последствие:** достаточно длинной обычной работы в одном окне для отказа
короткого API, даже когда нет active/quarantined операций.
**Исправление:** отделить лимит незавершённых действий от ограниченного окна
завершённой истории и durable recovery receipts.

### R08 · P2 · Успешный show может вернуться ошибкой последующего наблюдения без receipt show

**Trigger:** показ окна успешно завершился, но следующая inventory/AX/view
commit завершилась ошибкой либо timeout.

**Код:** `runtime/src/agent-methods.ts:514–526` ожидает tracked mutation, затем
делает отдельные refresh/inspect. Успешный receipt не включён в result schema
(`agent-methods.ts:172–174, 248–256`); последующая ошибка не связывается здесь
с уже выполненным show. Внутри transition есть ещё refresh до и после show
(`agent-methods.ts:568–581`).

**Последствие:** агент видит ошибку `show_window`, хотя окно уже показано.
`get_target_status` позволяет восстановить операцию, поэтому результат не
утрачен безвозвратно; однако основной ответ вынуждает дополнительное расследование
и создаёт риск лишнего повторного show.

**Исправление:** вернуть outcome самой мутации вместе с независимым состоянием
post-observation и operationId. Убрать повторные полные refresh, которые не
дают нового обязательного доказательства, после измерения настоящего flow.

### R09 · P2 · Первая установка по умолчанию выбирает ad-hoc

**Trigger:** установка на втором Mac без `--signing-identity-sha1`.

**Код:** `scripts/runtime-install.ts:400–401, 2791–2796` выбирает ad-hoc;
`planSigning` считает такую identity доступной. Постоянный certificate signer
проверяется только при явном выборе. Continuity установленной certificate
identity защищена `assertSignerContinuity`, то есть молчалый downgrade текущей
установки здесь не заявляется.

**Последствие:** default first-install path не обеспечивает требование стабильной
подписи и воспроизводимых обновлений второго компьютера.
**Исправление:** выпускной setup с обязательным выбором постоянной локальной
identity, явным отдельным development profile для ad-hoc и понятным планом.
Создание/импорт приватного ключа остаётся отдельным решением пользователя.

### R10 · P2 · Документы и план удаления не описывают одну текущую границу продукта

**Trigger:** новый исполнитель следует high-level API или запускает removal plan.

**Код/документы:** `docs/high-level-agent-api.md:16–19` всё ещё сообщает
source-only и MCP 0.3.0; таблица scroll в строке 55 расходится с `dx/dy/unit`
production schema. `scripts/legacy-source-removal-plan.json:3–4` ссылается на
старый baseline, строки 12/167 считают ignored legacy helper source-controlled.
`tests/computer-use/README.md` всё ещё описывает A02/A31 как следующие drivers,
хотя `tests/computer-use/matrix.ts:82,94` уже связывает их с evidence suites.
Root `package.json:8` по-прежнему запускает legacy REST.

**Последствие:** повторная реализация уже сделанного, неверная оценка gates,
попытка удалить не тот артефакт или запустить второй контур. Внешние REST
callers в `interpreter` и `demo` всё ещё присутствуют в исходниках.

**Исправление:** один актуальный release profile и индекс доказательств;
historical документы явно пометить историческими, removal plan пересоздать
после согласованной приёмки. Сейчас ничего не удалять.

## 2. Гипотезы и непроверенные ограничения

Эти пункты не засчитываются как доказанная причина последнего live-отказа.

- `AgentViewGuard.#synchronize` ждёт точного равенства один раз снятому
  watermark (`agent-view-guard.ts:356–383`). Если consumer успел перейти дальше,
  равенство с прошлым snapshot уже не наступит. Нужен управляемый schedule test
  вместе с реальным Hub, отдельно от доказанного R02.
- Собственная UI-реакция разрешена узко для single click после down
  (`meta_input_observer_binding.m:133–139, 297–303`,
  `meta_observer_command.m:813`). Keyboard Tab/Return, двойной клик, изменение
  структуры окна во время drag/text могут законно менять focus/AX tree и
  останавливать последовательность. Нужно различать допустимый эффект,
  неизвестную смену UI и физический ввод для каждого action, без blanket bypass.
- Sheet найден отдельной identity, но keyboard focus verifier требует exact
  `AXFocusedWindow == target` (`macos_backend.m:1228–1250`). Приложения могут
  представлять focus sheet иначе; успешный AXPress close не доказывает typing.
- Android проверяет serial и tuple forward; удаление и повторное создание
  внешним процессом идентичного tuple между проверками не различается
  (`android/src/adapter.ts:463–508`). Нужна явно описанная граница гарантий ADB,
  а не обещание абсолютного ownership при произвольном внешнем вмешательстве.
- `get_state` имеет default method budget 5 секунд, как и нижний inventory;
  у `show_window` несколько refresh, каждый может занимать значительную долю
  общего budget. Точные latency и полезность повторных проверок на Intel
  пока не измерены. Тестовые миллисекунды не заменяют эту метрику.
- Текущая проверка не доказывает отсутствие других дефектов. Это сквозное
  source/contract review с ограниченными воспроизведениями, не live-приёмка
  каждой ветви AppKit/AX/CG/ScreenCaptureKit.

## 3. Карта требований и готовности

Обозначения: **S** — проверенный source path; **T** — существующие проверки,
наличие которых подтверждено в исходниках; **T-now** — запущено в этом ревью;
**L-history** — датированная запись в cutover review, без нового live-повтора.
Строка со статусом «частично» не считается закрытой.

| Сценарий / требование | Владелец и код | Доказательство | Готовность / пробел |
| --- | --- | --- | --- |
| Найти скрытые, minimized, другие Spaces; отличить отсутствие и неполноту, A14–18 | Native `macos_backend.m`, `registry.c`, `inventory-priority`; Runtime `window-methods.ts`, `agent-methods.ts` | S; T registry/priority; L-history два одинаковых окна и scoped поиск после Space switch | Частично: hidden/minimized→show не завершён live; observer index отстаёт, R03 |
| Точный show без запуска другого браузера, A14 | `macos_backend.m:1253`, window actions/readback, `agent-methods.ts:514` | S: exact AX target, unhide/unminimize/raise/activate/readback; L-history show | Частично: receipt после post-observe, R08; Space transition не гарантируется OS |
| Sheets и owner, A19 | `owned-sheet`, `registry.c`, `ax-actions` | S/T; L-history open→separate surface→AXPress close | Реальный узкий flow подтверждался; popup/menu и keyboard sheet остаются |
| AX семантика native | `accessibility/meta_ax_inspector.m`, retained snapshot, `agent-targets.ts` | S/T; L-history RU/EN/emoji, values, родители | Optional AX error может делать aggregate incomplete; нет pagination в коротком API |
| Native screenshot и подтверждённые bytes, A21–26/41 | Screen adapter/native-driver, Native capture/router, Runtime frame/proof authorities | T-now 20 screen tests; L-history просмотр fixture PNG | Частично: overlays, защищённые/blank окна, mixed DPI, rotation и несколько displays live не приняты |
| Координаты только исходного кадра | `agent-pointer-methods.ts`, `input-hit-test.ts`, `input/src/authorization.ts`, native hit-test/point/geometry | S/T: frame/proof, свежая geometry/topology, отдельные inventory revisions | Архитектура сохраняется; успешный pointer click ещё не принят live |
| Pointer / scroll / drag, A27–28 | Input planner/adapter; Native executor/ledger; observer binding | S/T; L-history active move/restore probe, последний click partial/cancelled | Проба курсора не подтверждает click/drag/scroll в приложении |
| Keyboard / Unicode / composed clusters, A20/27 | `input/src/action-plan.ts`, `native/src/input_executor.m`, `executor.c` | S/T; AX чтение Unicode L-history | Запись точного текста, modifiers и Cmd+L→text→Enter live не завершены |
| Пользователь отвечает в Codex между действиями, A04/12 | AgentViewGuard/Bindings; Native view admission, focus verifier | T-now guard; source invalidation | Старое view должно стать stale; fresh show/observe должны восстановить обычный flow. R01–03 мешают |
| Собственная реакция окна и настоящий takeover | Native observer / input-observer / command binder | T-now observer; L-history уточнённый outcome последнего click | Классификация улучшена, но собственная реакция проверена только узко; причина missing target не доказана |
| Отмена и cleanup, A05–10 | AgentOperations → Core → Native job/executor/ledger/watchdog | T-now target cancellation; T native/Core suites | Source есть; active cancellation настоящего текста и отсутствие поздних posts live не приняты |
| Lost reply, restart и долговечные receipts, A11/42 | Core, client state, operation journal, recovery domain, startup recovery | S/T; L-history recovery ALL-UP предыдущего отказа | Target buckets не персистентны; после restart нужен durable operation/list_recent path. R06/07 |
| Два MCP клиента / private UDS, A02/03/31 | Host lock, transport, sessions/resources, Native fences | S/T process-startup/transport/Core | Один mutation owner реализован; конкурентные observer reads ломают boundary, R01 |
| Chrome profile/target, A34 | browser config/host, RuntimeBrowserAdapter, CdpBrowserDriver | S/T; L-history 5 target IDs | R04/05; одинаковые URL двух реальных профилей live не проверены |
| Chrome navigation/readiness/limits, A35–37 | `chrome/src/cdp-mode.ts`, `wait-ready.ts`, shared CDP, browser lifetime | S/T | Короткие click/type применимы к native, не к tab handle; browser mutations остаются низкоуровневыми tools |
| Optional Android, A38–40 | Android adapter, OwnedAdbForward, adb, browser lifetime | S/T; opt-in composition | Live устройства нет в последней записи; общего Android UI управления нет и не заявлять |
| Установка, имя, иконка, запрос прав, A32/33 | installer, runtime-entry, startup permissions, Native permissions/code identity | S/T; текущий manifest; L-history app/icon/grants | Настоящий bundle существует; R09; выдачу прав подтверждает пользователь/macOS, не requestIssued |
| Обновление / rollback / подпись | installer drain, witness, atomic promotion, manifests, installed launcher | S/T; L-history успешное обновление `61d1e9d` | Сохранение grants наблюдалось, не универсальная гарантия; второй Intel Mac не принят |
| Sleep/wake/lock/login, A44 | session lifecycle, observer, fences, startup recovery | S/T | Нужна отдельная live-приёмка, queued input не должен уходить в новый login context |
| Legacy cutover и внешние callers | manifests, removal plan, docs/skill | S: legacy всё ещё в checkout; named external callers перепроверены | Удаление преждевременно; согласовать миграцию consumers и обновить план |

## 4. Архитектурный вывод

### Сохранить

Путь `MCP STDIO → private UDS → RuntimeHost/Core → adapters → long-lived Native`
соответствует задаче. MCP не должен снова владеть desktop mutex или OS-focus.
Разделение Native, Input, Screen, Chrome и Android полезно: общий ресурс ввода
и durable outcome находятся в Core, а OS/API-specific proof — у адаптера.

Сохранить process incarnation и runtime/login/native generations, exact AX/CG
mapping, отдельные sheet identities, lineage-scoped handles, leases/fences,
проверку перед отправкой и matching-up cleanup. Сохранить различие `dispatch`,
`effect`, `cleanup`, `restoration`, а также запрет blind replay неизвестного
действия. Это предметные гарантии, а не лишняя сложность.

Frame bytes/hash, source capture identity, image→desktop mapping и отдельный
fresh point proof также нужны. Полный кадр не доказывает, что пользователь
разрешил клик или что нужная кнопка всё ещё нарисована в той же точке.

### Упростить согласование владельцев

Сейчас один пользовательский факт проходит через Native registry, observer
target index, Runtime TargetRegistry, AgentTargetRegistry, ObservationRegistry,
AgentViewGuard и AgentViewBindings. Не все эти структуры дублируют друг друга:
одна хранит OS identity, другая — право клиента, третья — конкретный кадр.
Удалять их целиком не требуется. Но для каждого производного состояния должны
быть один producer, lifetime и правило invalidation. R03 показывает, что
сегодня это не замкнуто.

Control queue, action queue, target-specific queue и resource admission решают
разные задачи. Их композиция должна иметь проверенный контракт конкурентности,
а не fatal busy guard в одном из слоёв. R01/R02 нужно исправлять совместно:
сериализация сама по себе не доказывает согласованность watermark и PUSH.

Facade хранит дополнительную историю поверх Core journal. Это оправдано для
ещё не admitted действий, но после admission authoritative outcome должен
оставаться в одном Core record. Развести active queues, краткую историю для
агента и долговечное recovery/dedup evidence; сейчас их budgets блокируют работу.

Повторяющиеся action outcome schemas и `projectOutcome` находятся в трёх
agent action modules и AgentOperations. Вынести единый owner projection после
фиксации требуемого публичного result; не проводить большой косметический refactor
вместе с исправлением observer.

Installer большой, но этапы plan/build/sign/drain/promote/doctor/rollback
предметно оправданы. Сначала сохранить и проверить transaction boundary;
позже отделить policy профиля, artifact verification и переход процессов,
не дублируя их в launcher или отдельных shell recipes.

### Практический цикл с живым пользователем

1. `system_health` один раз подтверждает машину и доступность нужного каталога.
2. `get_state` выбирает существующее exact окно. Неполный global inventory
   не запрещает работу с отдельно подтверждённой целью.
3. Для pointer/keyboard выполнить `check_input` до финального наблюдения:
   активная проба сама порождает события и может отозвать старое view.
4. Если Владимир переключился в Codex или другой Space, это обычное изменение
   desktop, а не неисправность пользователя. По продолжающемуся поручению
   выполнить exact `show_window`, проверить фактический результат, получить
   свежий `observe` с нужной семантикой/картинкой.
5. Выполнить одно действие по этому view. Не вставлять между наблюдением и
   действием ненужный вопрос, требующий вернуть focus в Codex.
6. Получить outcome и новое наблюдение; подтвердить эффект в приложении.
   При partial/unknown читать status, а не повторять ввод.

Автоматическое восстановление старого focus между действиями не нужно для этого
цикла и явно отложено. Восстановление удержанных keys/buttons и owned ресурсов
после отмены — другое требование, оно остаётся обязательным. Не следует ни
возвращать Владимира в старое окно после его вмешательства, ни просить его
навсегда перестать пользоваться компьютером.

`perform_focus` уже проверяет immediate foreground и AX-focus; hit-test проверяет
focused target до и после borrow. Поэтому последнюю partial click операцию
нельзя объявить просто кликом по background app без дополнительного evidence.

## 5. Короткий API и четыре согласованных сценария

Выбор короткого MCP над Runtime оправдан: агент не конструирует fences/leases,
не выбирает цель по URL/title, а cancel/status доступны по выданному handle.
Полный JS REPL не исправит R01–09 и сейчас увеличит объём lifetime/timeout/reset
работы. Полной совместимости с Codex API в реализации нет и она не требуется.

Однако сравнение в `docs/reviews/high-level-api-scenarios.md` — сравнение
fixture request JSON, а не доказательство успешности продукта. Для AX и cancel
исторический baseline вообще не завершал соответствующее действие.

| Сценарий | Историческая форма: низкий → короткий API, calls / JSON bytes | Реально необходимый текущий flow | Успех / восстановление |
| --- | --- | --- | --- |
| Скрытый Chrome | 2 / 424 → 2 / 148 | get_state → show_window; ещё observe для визуального подтверждения | Show fixture был успешен; hidden/minimized Chrome flow не принят; R03/R08 |
| Одинаковые URL двух profiles | 4 / 1899 → 3 / 202 | get_state(browser) → get_tabs(selected) → observe(tab) | Handles/selection в source; R04/R05; live profile isolation отсутствует |
| AX action | 2 / 446, blocked → 3 / 261, design fixture | get_state → observe(ax) → click(element) → observe для эффекта | AXPress sheet исторически работает; stale snapshot/cross-target должны отказывать |
| Отмена input | 3 / 622, blocked → 3 / 303, design fixture | get_state → при необходимости show → observe → type_text pending + cancel_target → status; probe отдельно | Source concurrent cancel есть; real text/cancel ещё не принят; lost reply через status, после restart через durable operation lookup |

Числа из прошлого документа не пересчитывались как live-измерение текущего
билда и не сравнивают response payload. Общие health/probe и проверки эффекта
в них не включены. У текущих generated handles другая длина; новое измерение
должно брать реальные запросы и ответы одного согласованного build.

Публичный слой пока неоднороден: show/click/type короткие, а `window_transition`,
application lifecycle и browser mutation tools принимают подробные DTO.
Tab handle позволяет observe, но не короткий native click/type; это нужно
явно показывать в capabilities/docs, не обещать универсальный Target.

Метрики следующей проверки: calls до подтверждённого эффекта; request **и**
response JSON bytes отдельно от изображения; число внутренних inventory/AX/CDP
обращений; wall time; правильная identity; normal/partial/unknown исход;
число действий восстановления; отсутствие replay и оставшихся ресурсов.
Не объявлять экономию токенов по одному размеру request JSON.

## 6. Незакоммиченные изменения

Исходные пять файлов сохранены без изменений: 95 добавленных, 3 удалённых строки.

**Observer draft:** четыре `.h/.m` файла добавляют merge APIs, но broker их не
вызывает. Это не исправление R03 в исполняемом пути. `mergeRecords` сохраняет
старые записи, если process start неизвестен/равен прежнему, и не удаляет
подтверждённо закрытое окно живого процесса. При ограниченном числе records
это может накапливать stale AX references. Он также разрешает replacing target
по равенству AX object; необходим явный контракт incarnation и закрытия, а не
молчаливая подмена производного индекса.

`mergeTargetRecords` не проверяет монотонность incoming inventory revision;
меняет общий mutable index до публикации metadata `_prepared`. Нужны условия
согласованного обновления, partial scope, process death/PID reuse, closed sheet,
callback во время merge и capacity. Тестов новых методов нет. Не принимать
черновик автоматически и не выбрасывать его без решения по архитектуре.

**Screen test draft:** checkpoint `screen.capture-started` ставится после
реального вызова fake driver start и регистрации pending task; затем test clock
подводится к deadline. Он действительно отделяет admission от ожидания результата
и устраняет прежнюю зависимость admission от 15 мс wall time. Проверка всё ещё
использует короткий настоящий timer для bounded wait, но уже после нужной границы.
Точечный набор прошёл. Это разумный локальный кандидат; в данном ревью он
не менялся, не коммитился и не объявляется исправлением production capture.

`sh native/scripts/check-observer.sh` прошёл на текущем working tree. Это
подтверждает сборку и существующие injected observer tests, но не integration
merge APIs, не real callback и не успешный ввод.

## 7. Установка, второй Intel Mac и legacy

Текущий прочитанный installed manifest подтверждает:

- source `61d1e9daf14e7c1f2ced5974badddde6b87b52ea`;
- release `release-a1308ceda1755e5b96464c6a`;
- runtime/native suffix `47a1c96c07f1223d1fbf6e13`;
- `signing.mode: identity`, профиль `desktop-browser-selected`;
- stable `computer-use.app` существует в пользовательском Application Support.

Это проверка metadata, не новая проверка подписи работающего процесса, TCC,
observer или количества активных операций. Записи о четырёх grants, иконке,
успешном doctor и 36 direct tools взяты из dated cutover/startup документов.
В этом ревью установленное приложение, службы, permissions и UI не менялись.

Второй Mac требует самостоятельного setup: canonical checkout, соответствующий
Intel/macOS профиль, Bun и Apple toolchain, локальная постоянная signing identity,
expected hostname, собственные browser endpoint/profile configuration, grants,
installed doctor и **свои** live receipts. Нельзя переносить первый Mac's
manifest, runtime credential, audit identity или TCC grants как готовую установку.
Системные зависимости — MacPorts; установка зависимостей в ревью не выполнялась.
Профиль `full` требует отложенный `input.interaction`; для принятого объёма
использовать честный `desktop-browser-selected`, не ослаблять required set.

Source installer уже имеет clean-checkout gate, стабильный bundle, подпись
вложенного helper до app, проверку hashes/requirements, drain, durable witness,
rollback и doctor. Сохранение grants после обновления было наблюдено на первом
Mac, но нельзя гарантировать его для любой смены macOS/signing identity.

Удаление legacy сейчас не является следующим шагом. Named callers заново найдены
в canonical `interpreter/packages/browser-agent/src/meta-chrome.ts` и трёх
скриптах `demo`, перечисленных в `docs/legacy-callers.md`. Это существующие source
зависимости, не доказательство работающих процессов. Их миграция — отдельная
работа соответствующих владельцев. Storybook сохраняет свой MCP/private browser.
Архивный контур не читался и не затрагивался.

## 8. Минимальная последовательность дальнейшей работы

1. **Зафиксировать контракт и контрпримеры R01–03.** Сформулировать один lifecycle
   registry/index, порядок coverage/PUSH, конкурентность control, нормальный
   возврат после пользовательского переключения. Воспроизведения должны идти
   через production producer→consumer, включая command loop. Gate: parallel
   observe не завершает broker, поздний согласованный snapshot не создаёт gap,
   поздно обнаруженный exact target получает правильную observer identity.
2. **Реализовать этот согласованный observer/input срез.** Оценить draft merge
   заново; не ослаблять targetless-focus отказ. Проверить closed/replaced window,
   sheet, PID reuse, partial inventories и истинное физическое вмешательство.
   Gate: fresh show→observe→одно действие работает после ответа в Codex; takeover
   во время ввода останавливает будущие события с честным cleanup.
3. **Исправить Chrome AX и instance verification, R04/05.** Gate: дерево содержит
   известные кнопки/поля fixture; две одинаковые страницы разных профилей получают
   разные доказанные browser identities; смена endpoint отвергает старый handle.
4. **Закрыть долгую эксплуатацию и results, R06–08.** Gate: более 128 действий
   одной цели и pressure журнала проходят без потери recovery/dedup; unresolved
   не удаляются; show сохраняет свой receipt даже при failed post-observation.
   Проверить restart/lost reply в том же acceptance срезе.
5. **Собрать кандидат с согласованными документами и setup, R09/10.** Принять
   отдельно детерминизацию screen test. Выполнить targeted suites, TypeScript,
   native checks и один общий safe прогон для итогового кандидата. Отсутствующие
   live rows остаются not-run. Только после этого — разрешённая установка и
   fresh direct MCP catalog, без подмены внутренностей подписанного app.
6. **Завершить live-приёмку первого Mac.** Exact hidden/minimized/show/Space;
   pointer click/double/right, Unicode/modifiers/shortcut, anchored scroll/drag,
   sheet typing, cancellation до/после down и посреди text, lost reply,
   sleep/wake, capture geometry/overlays/DPI по доступному оборудованию.
   Для каждого сохранять expected/actual и oracle/кадр, receipt и cleanup.
7. **Повторить обязательный профиль на втором Intel Mac и проверить update.**
   Первый setup, grants, signed update и controlled rollback должны иметь
   независимое evidence. Если второй компьютер недоступен, переносимость
   остаётся неподтверждённой, а не считается выполненной по исходникам.
8. **Завершить legacy migration одним согласованным изменением.** Обновить
   removal plan/reverse imports, manifests, lock, docs и skill; сначала решить
   внешних callers. После удаления проверить installed runtime и новое direct
   MCP подключение снова. Не возвращать REST fallback для удобства проверки.

Порядок не требует переписывать всю систему. Он сначала устраняет несогласованные
границы, затем доказывает обычные пользовательские сценарии и лишь после этого
убирает старые входы.

## 9. Выполненные проверки и предел результата

| Проверка | Результат |
| --- | --- |
| AGENTS.md, branch/HEAD/dirty diff | main / 40b1b82; пять исходных dirty файлов сохранены |
| Installed current/manifest, только выбранные несекретные поля | Совпадает с `61d1e9d` / release-a1308… |
| Hub: ответ после нового PUSH | Воспроизведён ложный terminal gap, R02 |
| Hub: два coverage одновременно | Два Native requests в полёте; fatal busy-ветка установлена source, R01 |
| Production Chrome driver с корректной семантикой test CDP | Пропущена button при `truncated:false`, R04 |
| AgentOperations + настоящий target registry, 129 попыток | 129-я не доходит до handler; refresh сохраняет exhausted handle, R07 |
| `bun test runtime/tests/observer-hub.test.ts runtime/tests/agent-view-guard.test.ts runtime/tests/agent-operations.test.ts chrome/tests/cdp-driver.spec.ts screen/tests/adapter.test.ts` | 51 pass, 0 fail, 217 assertions, 5 файлов |
| `sh native/scripts/check-observer.sh` | Exit 0; observer, command, index builder, input binding, view admission suites прошли |
| Named external REST callers | Source references в interpreter/demo всё ещё присутствуют |

Пробные программы выполнялись из stdin; production/test/config файлы не менялись.
Один первоначальный запуск CDP-пробы не разрешил root import `@meta/shared`;
после исправления только probe import на точный source путь выполнено указанное
воспроизведение. Это не дефект workspace dependency consumer.

Общий suite повторно не запускался: для read-only review не было причины
повторять прежние 145 файлов. Root typecheck, полная Native suite, установка,
doctor и live desktop checks в этом проходе не выполнялись. Исторический
результат `879 pass / 1 skip / 1 fail` не объявляется исправленным общим прогоном.
Системный clipboard, реальный ввод и пользовательский UI не использовались.

**Общий вывод:** проект уже имеет подходящее архитектурное основание, но ещё
не готов к полноценной повседневной работе на двух Mac. Продолжение только
последнего локального focus-fix недостаточно: прежде нужны R01–06 и проверенная
композиция обычного flow. Короткий API следует сохранить; REPL и полную
совместимость с Codex сейчас добавлять не нужно.
