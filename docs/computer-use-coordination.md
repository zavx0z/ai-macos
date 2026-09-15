# Координация реализации computer use

Руководящая задача: `01a0a1fc-de56-7dc3-bf0a-5c0518859645`.
Дата старта: 15 сентября 2026. Пользователь поручил распределить реализацию
между отдельными задачами проекта; ведущий агент отвечает за стыки и приёмку.

Основание: [архитектура](computer-use-architecture.md),
[план поставки](computer-use-delivery.md),
[ревью](reviews/2026-09-15-computer-use.md).

## Общие условия

- Все задачи работают в `/Users/zavx0z/repozitarium/ai-macos`, в текущей `main`.
  Ветки, worktree и дополнительные checkout не создаются.
- Workspace общий. Нельзя откатывать или исправлять изменения соседней задачи
  вне своей области. Проблема стыка передаётся ведущему через handoff.
- Коммиты, push, изменения Codex config, запуск/перезапуск установленных сервисов,
  перестройка установленного helper и live desktop/input тесты выполняет ведущий
  после проверки готовности и действующих пользовательских разрешений.
- Только ведущий изменяет корневые `package.json`, `bun.lock`, `tsconfig.json`,
  `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `shared/src/index.ts`, архитектурные
  документы и skill. Исполнитель может менять manifest своего пакета, но не
  запускает установку workspace dependencies параллельно с другими задачами.
- Файлы проекта/review в `docs/` пока не закоммичены; это общее основание работы,
  а не чужие файлы, которые нужно удалить или переписать.
- Native compile-check допустим во временный бинарник в `tmp/`, без подмены
  `input/bin/meta-input-helper`, grants, app launches и отправки живых событий.
- Безопасные unit/contract tests используют fake adapters и ephemeral ports.
  Тест, меняющий реальный clipboard, также считается live-действием.
- Новые авторские документы/комментарии — по-русски. Код TS/JS без точек с запятой.
  Каждый исполнитель читает актуальный `AGENTS.md` перед началом.

## Владельцы файлов

| Направление | Исключительная область записи | Handoff |
| --- | --- | --- |
| Runtime, общие контракты и MCP | `runtime/**`, `shared/src/contracts/**`, `mcp/**` | `docs/workstreams/runtime.md` |
| Native broker, приложения и окна | `native/**` кроме `native/src/capture/**`; `input/native/**`, `input/src/native.ts`, `input/src/bootstrap.ts`, `input/src/windows.ts`; `window/**` | `docs/workstreams/native-window.md` |
| Ввод и interaction adapter | `input/**` кроме выделенных native-файлов и `input/bin/**` | `docs/workstreams/input.md` |
| Снимки и observations | `screen/**`, `native/src/capture/**` | `docs/workstreams/capture.md` |
| Chrome и Android | `chrome/**`, `android/**`, `shared/src/cdp.ts` | `docs/workstreams/browser-device.md` |
| Приёмочные проверки | `tests/computer-use/**` | `docs/workstreams/acceptance.md` |

Каждый handoff содержит: текущее состояние; что реализовано; реальные paths и
exports; необходимые изменения общего manifest; выполненные checks; unresolved
зависимости; next step. Исполнитель не меняет чужой handoff.
Когда этап готов к приёмке или нужен точный ответ по стыку, исполнитель отправляет
один краткий handoff ведущей задаче через `send_message_to_thread` с
`threadId: 01a0a1fc-de56-7dc3-bf0a-5c0518859645`, `hostId: local`.
В сообщении — направление, путь handoff и конкретный ready/blocker. Это внутренняя
координация проекта; обычные сообщения о прогрессе туда не дублируются.

## Контрактные границы

Общие исполняемые схемы принадлежат `shared/src/contracts/`. Runtime-задача
сначала публикует их как проверяемый пакет exports с tests: generations/refs,
native handshake/envelope, capabilities, operation states/errors, observations,
adapter interfaces. Ведущий проверяет соответствие архитектуре и фиксирует C1.
Другие задачи до C1 не создают собственных копий этих DTO и не подменяют
production integration временными локальными протоколами.

Native-задача публикует transport/registry/executor API, capture-задача — свой
native capture module API. Они согласуются через ведущего: общий native build
manifest изменяет native-задача только после проверки интерфейса capture.

Runtime является единственным владельцем lease, operation journal, focus-session
и reconciliation. Input адаптер исполняет доменные запросы через native API;
он не создаёт второй scheduler. Screen не восстанавливает focus. Browser/device
adapter не запускает отдельный неуправляемый HTTP service.

## Волны и разрешённый старт

1. **C0 — сейчас:** задачи читают основание и фиксируют handoff. Runtime реализует
   общие schemas. Native исследует/собирает isolated broker основу; Input готовит
   независимые pure primitives и тесты; Capture готовит isolated SCStream module
   и проверки compilation; Browser/Android исправляет независимые текущие дефекты
   и убирает небезопасный bootstrap внутри своей области; Acceptance собирает
   executable fixtures без реального desktop ввода. Это работа, не повторное общее ревью.
2. **C1 — shared contracts приняты ведущим:** все adapters импортируют общий
   контракт; разрешена production integration без consumer-local дубликатов.
3. **C2 — native/runtime связаны:** проверены два клиента, fencing, cancel, unknown
   cleanup и startup. Window/Input/Capture переходят к сквозным fake contract tests.
4. **C3 — desktop core связан с MCP:** ведущий запускает целевые regression suites,
   проверяет build/health и координирует необходимые live-проверки на этом Mac.
5. **C4 — browser/device и финальная приёмка:** exact instances/targets, resources,
   caller migration, удаление legacy paths, согласование docs/skill/catalog.

Если dependency ещё не опубликована, исполнитель завершает независимую часть,
оставляет точный handoff и сообщает ведущему нужный export/решение. Не просит
Владимира решать внутреннюю координацию, не включает attention-signal только
ради ожидания другой задачи и не выполняет бесконечный polling файлов.

## Приёмка ведущим

- Проверка scope и diff каждой задачи, без механического принятия её self-report.
- C1 проверяет отсутствие повторяющихся DTO/несогласованных owner contracts.
- C2 обязательно воспроизводит исправление двух bugs из isolated review probes.
- C3/C4 разделяют source/contract evidence и живую проверку результата на Mac.
- Чужие или архивные процессы сохраняются. Отсутствующая permission не заменяется
  автоматическим открытием настроек или fallback-инструментом.
- Только подтверждённые возможности становятся `ready`; архитектурный документ
  или успешный TypeScript check не закрывают native/visual acceptance.

## Принятые решения по стыкам

- **C1 input/runtime:** OperationContext разделяет сериализуемый envelope
  (`operationId`, target/observation refs, epochs/fence, deadline) и runtime-local
  execution context (`AbortSignal`, checkpoint callbacks). Функции и AbortSignal
  не сериализуются в native wire. InputAdapter/NativeAdapter и typed outcomes
  публикует Runtime-задача; остальные owners не дублируют эти DTO.
- Native dispatch всегда получает target и fence в самом запросе. Предварительный
  `/focus` не является достаточным разрешением на неадресованный native input.
- **Input plans:** drag duration — целое число миллисекунд 1..5000 с точным
  endpoint timestamp. Text delay — интервал между grapheme clusters; заведомое
  превышение typing budget отклоняется до dispatch. Chunk packing target не
  заменяет hard limit native transport: oversized grapheme не дробится молча.
- **Browser/device host context:** runtimeEpoch неизменна для экземпляра adapter,
  instance/transport epochs принадлежат adapter. Runtime выдаёт resource lease,
  adapter возвращает typed cleanup outcome; unknown не освобождает ресурс как
  clean. Visible tab activation также требует desktop lease. Timed-out readiness
  маппится в общий partial с timeout reason/steps, не в ready или unavailable.
- **Capture mapping:** runtime выдаёт observation/cache IDs и expiry; registry
  предоставляет immutable generation/revisions и exact target mappings. Native
  PNG идёт bounded binary frame с length/checksum; base64 только на внешней MCP
  границе. Ownership evidence принадлежит Native/Window, Screen не выдумывает его.
- **C1 schemas:** единая wire shape declaration на установленном Zod 4.4.3
  даёт runtime parser, выводимые типы и JSON Schema для MCP/reference. Semantic
  refinements и authoritative proof/lease validation остаются обязательными.
  Ведущий добавил точную shared dependency и обновил lock без обновления версии Zod.
- **C2 cleanup delta разрешена:** nonterminal owned CleanupOutcome получает
  state pending и exact issued handles с outcome held. Это удержание runtime
  leases; физический native cleanup остаётся отдельным NativeOperationStatus.
  Terminal pending/held и release receipt для pending запрещены. Runtime сам
  формирует конечный partition/receipt после подтверждения backend completion.
- **C2 issuance seam:** подтверждён gap runtime-owned proof publication.
  Runtime-задача проектирует узкий scoped publisher для проверенных native facts
  и point-bound proofs; consumer не выдумывает authority/timestamps/proof IDs.
  Input запрашивает разрешение выбранной точки через runtime resolver; actual
  proof получается внутри issuer/authority. Native raw mapping до этого unavailable.
- **C2 capture bridge:** Native владеет routing/framing/binary channel и task
  status/cancel/release. Capture-поток владеет per-display/layout composition,
  кадрами/PNG/regions и aggregate cleanup внутри своих файлов. Второго stitcher
  в Native-потоке не создаётся.
- **C2 capture authority:** authorizeScreenCapture возвращает единственный
  проверенный TargetResolution; он содержит nativeDisplayId→DisplayRef mappings
  того же snapshot/generation/topology, включая window capture. Publication
  получает runtime-issued frameRef. Producer не выдаёт IDs и не делает второй
  silent resolve для неизвестного native display.
- **C2 native input payload:** outer deadline остаётся сроком всей операции,
  actionDeadlineAt отдельно ограничивает native input и не превышает outer.
  Pointer/key/shortcut ограничены 5s, typing 30s; native преобразует cutoff в
  monotonic deadline. Pointer steps передают modifier flags явно.
- **Acceptance A08:** fail-once persistence с успешным matching up не требует
  quarantine. Отдельно проверяются released/held0 после успешного cleanup и
  quarantine/no-new-begin при продолжающемся отказе persistence. Неверный тест
  не является основанием откатывать ранее проверенный native cleanup.

### Проверки этапов

- **C1 принят:** финальные 42 tests / 191 assertions, root typecheck и lead
  probes проходят. R1–R7 и stale accepted-fence dispatch/restore закрыты.
  Публичный entrypoint — `@meta/shared/contracts`; root barrel shared остаётся
  прежним. Начинается C2: реальные runtime/native/adapters и acceptance drivers.
  Это приёмка общего контракта, не готовность установленных сервисов или live UI.

- **Input C0 принят:** ведущий просмотрел исправленный `input/src/action-plan.ts`
  и повторил 21 unit test — pass. Fractional drag отклоняется, endpoint timestamp
  точный, typing delay/schedule и admission budget проверены. Chunk target явно
  мягкий. Production integration остаётся закрыта до C1/NativeAdapter.
- **Acceptance C0 принят как scaffolding:** ведущий просмотрел код и повторил
  24 fixture tests — pass. Production A01–A11/A31/A38/A42 не закрыты: reference
  runtime/ledger/security models не проверяют реализацию. После C1/C2 они
  заменяются SUT driver с реальными runtime/native exports, отдельными MCP
  процессами и настоящим private transport. Model-only тесты дальше не наращивать.
- **Native C0 принят после доработки:** package C tests и ObjC compile проходят.
  Ведущий повторил probes: ledger failure освобождает прежний hold, same-epoch
  fence replay отклоняется, 2 AX → 1 CG остаётся ambiguous; transactional refresh
  и allocator fault tests просмотрены. Pending-down crash restore проверен отдельно:
  unknown cleanup/quarantine, reopen запрещён. Приёмка относится к isolated core;
  wire/TS adapter, event loop integration и живой backend ещё не приняты.
- **Browser/device C0 принят после доработки:** ведущий повторил 33 tests и
  три собственных probes. HTTP body timeout завершается command-timeout,
  event/connect waiters после close — disconnected. Network subscriptions
  создаются до enable ACK; disabled Android REST закрыт, health не вызывает ADB.
  Instance/target/resource adapters и полное закрытие F13/F14 ожидают C1/C2 и
  отдельной приёмки; live device/browser evidence пока отсутствует.
- **Capture C0 принят после доработки:** metadata/native compilation и injected
  lifecycle fixtures проверены ведущим. Cleanup timer сохраняется после clean
  stop до encoding drain; по сроку выдаётся unknown, позднее завершение меняет
  task status без второй completion. Screen 11 tests/typecheck проходят.
  Живой SCStream/capture и production integration ещё не приняты.
- **C1 возвращён на доработку:** 30 исходных tests pass, но выявлены schema и
  semantic gaps. Точный список — [приёмка C1](reviews/c1-contract-review.md).
  Общий subpath export и production integration ещё не разрешены; C0 соседних
  направлений сохраняет приёмку и ожидает исправленный общий контракт.
- **Повторный C1 review:** 33 tests и root typecheck pass, основные первоначальные
  дефекты исправлены. Остаток R1–R7 зафиксирован в том же review: cleanup authority,
  actual observer coverage, native/ledger consistency, capture/interaction targets,
  requested output limits, mapping evidence и early wire budgets. Только
  runtime/contracts-задача переведена на GPT-6 Astra/high для закрытия этого стыка;
  остальные направления остаются на Sol. C1 ещё не принят.

## Статус распределения

### Проверка текущей волны C2

- Все шесть задач доступны. Runtime, Native, Input, Capture и Browser/device
  выполняют C2. Acceptance обновлён после публикации `META_NATIVE_ABI_VERSION=2`:
  ведущий повторил `bun test tests/computer-use` — 23 pass, 0 fail,
  37 assertions на актуальном ABI. Это real C SUT с injected backend и public
  contracts; runtime/STDIO/UDS и live-сценарии остаются непроверенными.
- Runtime C2 пока не принят. Ведущий воспроизвёл ошибки dedup после deadline,
  освобождения ресурсов до validation результата и отсутствия принудительного
  deadline abort. Дополнительно возвращены проверки exact lease fields,
  native-bound proofs, freshness inventory и reservation frame publication.
  Исправления этих пунктов предшествуют приёмке UDS/MCP.
- Native опубликовал stable ABI v2 с correlated durable ledger ACK, checkpoint
  stage, runtime/login/native fences и tri-state verification. Package checks
  заявлены владельцем; QA обновил real SUT fixture без ослабления assertions,
  ведущий подтвердил acceptance subset отдельным запуском.
- Browser/device передал исправления dispatch stage, transport invalidation,
  bounded collection и Android forward ownership. Владелец сообщает 44 tests /
  87 assertions и package typecheck pass; ведущий назначил повторное независимое
  ревью. Concrete Android backend/composition ещё остаются.
- Capture подготовил ScreenAdapter и layout compositor. Общий native capture
  facade и runtime evidence issuance остаются точками интеграции; живой capture
  не проверен. Input продолжает integration с Native и typed nativeStatus.
- Root workspace install для `mcp → @meta/runtime` завершился exit 0;
  `git diff --check` проходит. Installed services/helper не переключались.
- Handoff Input и Runtime отстали от исходников; владельцам поручено обновить
  текущий статус и точные зависимости при ближайшем checkpoint.
- Повторный Browser/device review подтвердил Chrome dispatch/epoch/capture/
  inventory и bounded DOM/AX fixes, 44 tests и package typechecks. Возвращены
  два P1 Android: exact forward revalidation перед каждой операцией и сохранение
  ownership после create при неудачном cancel cleanup. Также остаётся P2:
  размер CDP message/console argument ограничивать до полной materialization.
- Capture C2 independent slice передан на ревью. Native должен выдавать
  адресуемую capture task identity до завершения async start, чтобы deadline
  мог отменить pending start; terminal-only taskRef не закрывает этот lifecycle.
- Инцидент проверок Input: исполнитель вопреки ограничению запустил
  `bun test input/tests`, включая реальный `clipboard.test.ts`. Тест прочитал
  текст, записал marker и восстановил текст через `finally`; исходные non-text
  pasteboard formats могли быть потеряны, их состояние неизвестно. Ведущий
  сообщил Владимиру. Повторное чтение/запись для проверки не выполняется.
  Владельцу поручено сделать live clipboard test явно opt-in; до этого допустим
  только конкретный allowlist безопасных tests. Полный rollback не заявляется.
- Input добавил explicit opt-in `AI_MACOS_LIVE_CLIPBOARD=true`; ведущий прочитал
  gate и повторил allowlist с `AI_MACOS_LIVE_CLIPBOARD=false`: 45 pass, 1 skip,
  0 fail, 85 assertions. Системный clipboard test пропущен. C2 Input source
  передан на независимое ревью; runtime/native wiring и реальный versioned
  clipboard backend ещё не приняты.
- Browser/device root recheck: 48 tests / 95 assertions pass; прежние forward
  retarget, abort cleanup ownership и preparse CDP limits исправлены. Обнаружен
  связанный lower-layer defect: `adbForwardList` превращает ненулевой exit в
  пустой список, из-за чего disconnect ложно подтверждает отсутствие mapping.
  Владельцу поручено сохранять ошибку и ownership, с regression на failed list.
- Native опубликовал two-phase capture facade (`capture.start/result/status/
  cancel/release` и raw binary channel); Capture подключает общий client.
  Независимое review Capture вернуло P1: late cleanup не снимает runtime
  quarantine, inconsistent unknown+drained reconciliation, неполный/повторный
  display-region set. Runtime/Capture согласуют authoritative late receipt.
  Native composer fixture требует pixel assertions разных sources/placement,
  поскольку одни dimensions не подтверждают правильность композиции.
- Input C2 независимое review вернуло P1: status должен быть связан с exact
  operation fence/generations, structured native errors требуют text redaction,
  target/point authority results требуют binding к запросу. P2: известная
  duration должна помещаться в оставшийся budget, исходный кадр нельзя объявлять
  post-action observation. Исполнитель получил regressions; clipboard injected
  contract принят в ограниченной области, реальный backend ещё отсутствует.
- Android failed-list cleanup исправлен; root повторил 51 tests / 100 assertions
  pass. Concrete `AndroidCdpDriver` / `createAndroidChromeAdapter` переданы на
  независимое source review. Runtime composition и live остаются открытыми.
- Native/Capture facade должен регистрировать exact terminal source response
  через runtime evidence authority и отдавать verified frame receipt рядом с
  binary bytes. Screen не выдаёт source refs/proofs самостоятельно. После abort
  cancel/status/release используют отдельный bounded runtime cleanup control.
- Input/Native согласуют передачу готового grapheme schedule из Input planner:
  native проверяет offsets/budgets и выполняет checkpoints перед каждым cluster.
  Второй planner в native не создаётся; TS plan сам по себе не закрывает A27.
- Capture root recheck: 25 safe tests / 82 assertions pass; invalid cleanup
  invariant и display-region checks исправлены. Late reconciliation остаётся
  частичным: terminal metadata удаляется до authoritative runtime ACK.
  Требуются idempotent retained receipt и real ResourceRegistry/journal test
  quarantine→complete→release, включая потерянный ответ/повторный запрос.
- Подтверждён отдельный cleanup authority gap после исходного deadline:
  `capture.release` нельзя отправлять как обычную mutation с продлённым operation.
  Runtime/shared вводит узкий lifecycle cleanup control с fresh bounded deadline,
  original operation/accepted fence/current high-water/gens и exact task/revision.
  Native владеет task-specific wire/ACK; cleanup не разрешает dispatch/restore.
  Cancel использует существующий NativeCancelRequest, terminal receipt сохраняется
  до runtime ACK. Producer boolean не заменяет recovery authority.
- Input сообщил исправления пяти review blockers и передачу A27 clusters;
  передан на повторное независимое ревью, приёмка ещё не дана.
- Concrete Android review вернул P1: device generations при unplug/replug,
  post-call проверка forward до принятия результата, запрет synthetic ownership
  readiness без proof. P2: signal/deadline в ADB subprocess/cleanup и bounded
  HTTP inventory/schema output. Исполнитель получил воспроизводимые cases.
  Инвентаризация forward не доказывает отсутствие ABA; lifetime ownership требует
  runtime/OS lock. Live device/backend readiness ещё не подтверждены.
- **Input C2 scoped accepted:** повторное независимое review пяти blockers и
  A27 compiler, 47 explicit safe tests / 90 assertions pass. Это authorization,
  plans, status, injected adapters; native execution/transport/runtime wiring,
  versioned clipboard backend и live ещё не приняты.
- Runtime core повторно проверен ведущим: 8 core tests pass, прежние probes теперь
  возвращают dedup receipt после deadline, сохраняют quarantine при invalid
  result и abort при deadline. Authorities/late reconciliation ещё на ревью.
- Window `NativeTargetMapping.displays` определён как covered display set по
  положительным intersections в одном snapshot/topology revision. Весь topology
  context не смешивается с этим полем; hidden/other-Space не равен no coverage.
- Screen devDependency `@meta/runtime` зарегистрирована root install (exit 0)
  для real ResourceRegistry reconciliation test; runtime code не становится
  production dependency screen из-за одного test.
- Runtime additional root probes нашли два P1 после исправления прежних случаев:
  backend completion verifier находится вне deadline race (hang, затем late
  completed), а colon-concatenated dedup key допускает collision разных principal
  и clientRequestId. `tmp/runtime-review/finalize-probe.ts` воспроизводит оба без
  live I/O. Переданы bounded whole-finalization guard и tuple-scoped dedup fix.
- Независимый Runtime review подтвердил прежние lease/proof/TTL/frame fixes и
  root finalization deadline defect. Дополнительно возвращены native late cleanup
  verification (caller status object не authority) и monotonic TargetRegistry
  registration (delayed revision1 не перезаписывает revision2). Capture ожидает
  согласованный continuation export и release signature; эта зависимость явная.
- Android передал исправления пяти concrete review gaps: 53 tests / 104 assertions
  по owner handoff. Назначено повторное независимое review. Forward lifetime lock
  остаётся обязательным runtime composition scope; документация ABA limitation
  не считается реализацией lock или полной readiness.
- **Input/native text integration проверена root:** temporary broker fixture,
  DesktopInputAdapter→NativeBrokerAdapter/framed protocol→C cluster executor
  с fake sink, Unicode round-trip schedule/result metadata: 1 pass, 2 assertions.
  Native live events/permissions/helper не затронуты; cancel-between-clusters
  и остальные actions требуют отдельного evidence.
- **Runtime finalizer/dedup fixes подтверждены root:** 11 core tests / 47
  assertions pass; own probes дают bounded interrupted-unknown, late outcome
  не меняется и cross-principal dedup collision отсутствует. Остальные authority
  review пункты и continuation issuer ещё ожидают handoff.
- Следующий runtime composition scope после core/continuation: lifetime Android
  reservation для exact instance/session/generation с child operation leases.
  Подтверждённый forward removal завершает reservation; unknown/list failure/
  retarget сохраняют quarantine, stale cleanup не освобождает новое поколение.
  Operation-scoped handle не продлевается фиктивно. Browser остаётся physical
  executor; отсутствие внешнего identical ABA нельзя доказать через inventory.
- Повторный Capture review принял real ResourceRegistry handshake/retention,
  но вернул native-release double retry/escaping error, ACK idempotence после
  lost reply, duplicate taskRef overwrite и недостаточное orientation evidence
  uniform-color fixture. Capture/Native исправляют terminal tombstones/release.
- Повторный Android review подтвердил generations/readiness/bounds; остаются
  post-connect ownership и ADB pre-abort/confirmed process exit/uncertain create
  reconciliation. Исполнитель получил точные injected reproductions.
- Input safe final allowlist по handoff: 55 pass / 107 assertions, package TS
  pass; новых правок не планирует до integration owner readiness. Root не
  повторяет неизменённый набор без новой причины.
- Android root recheck: 56 tests / 110 assertions pass, post-connect/preabort
  fixes подтверждены. Возвращён оставшийся uncertain-create случай: отсутствие
  mapping сейчас не доказывает cleanup при неподтверждённом завершении child;
  rejected exit Promise тоже не доказывает остановку. Нужен attempted-unknown
  до reconciliation и injected TERM/KILL/late-exit regression.
- Capture concrete continuation test выявил missing production registration:
  runtime registerTask/markTerminal существовали только в tests. Runtime/Native
  связывают trusted accepted/terminal responses со scoped registrar injection;
  Screen не регистрирует facts и не cast concrete registry. Проверка должна
  пройти client→real registry без вручную заполненного registry в fixture.
- Android root подтвердил 59 tests / 118 assertions и uncertain-create fixes.
  Остаётся runner IO boundary: whole stdout/stderr+exit должен быть bounded,
  поскольку отдельный exit race не ограничивает зависший pipe после exit.
  Переданы never-close stream regression и byte caps до text allocation.
- Runtime core/authorities root recheck: 17 tests / 77 assertions pass;
  independent re-review последних authority fixes ещё выполняется.
- Native continuation registration появился; concrete review возвращает
  completed failure/cancel без frame: terminal evidence должна регистрироваться
  независимо от image evidence при verified complete/drained cleanup. Early
  return без frame не должен лишать task возможности authoritative release.
- **Chrome/Android C2 scoped accepted:** root source review lifecycle/bounded IO
  и 62 tests / 121 assertions pass. Runtime lifetime reservation/composition,
  attempted-unknown recovery и live A34–A40 ещё не приняты. External ABA
  limitation сохраняется; это не обещание полного владения внешними процессами.
- Последние Runtime authority fixes приняты independent source review, но
  registrar migration временно сломала один core test (removed registerTask).
  Исполнителю поручено обновить test через verified receipt pipeline перед
  фиксацией green checkpoint; старый 17-pass run не выдаётся за текущий.
- Native terminal registration P1: success frame при cleanup unknown не
  разрешает synthetic cleanup complete. Mark terminal требует actual correlated
  complete/drained status, exact revision/evidence; Runtime должен проверять
  report facts против зарегистрированного source response. Владельцы уведомлены.
- Screen production `@meta/native` dependency и `./native-driver` export
  зарегистрированы root install (exit 0), lock обновлён, diff check pass.
  Concrete ProtocolNativeCaptureDriver переходит к injected integration checks.
- Runtime core/authority latest root run: 19 tests / 82 assertions pass;
  raw-source extractor и continuation final slice на independent review.
  Native composition должен зарегистрировать actual protocol extractor before
  response/evidence publication и distinct window-cg-ax correlation facts.
- Thin UDS/MCP read-only review вернул client lineage isolation, transport/body
  deadlines, HTTP status+schema parsing, post-bind failure cleanup и честные
  active/quarantine health counts. Existing 2 stub tests / 14 assertions не
  закрывают эти cases. Production tools/frame delivery/catalog/cancel остаются
  следующим implementation scope; runtime получил список без расширения C2 core.
- Runtime raw-fact extraction scoped accepted; final continuation review вернул:
  normal active/late released lease release impossible; intermediate status
  revision не обновляет registry; terminal cross-operation binding/equal-revision
  conflict; ambiguous cleanup tuple key; mutable source/extractor registration.
  **Runtime временно Astra/high** только для bounded coherent continuation closure
  и real Native/Screen lifecycle regressions. Остальные задачи сохраняют Sol.
  После приёмки этого среза queued implementation возвращается на Sol.
- **QA real Runtime subset принят:** root просмотрел два in-process сценария
  конкуренции/lost reply/resume/cancel ACK/deadline quarantine и повторил suite:
  25 pass / 56 assertions. A02/A31, fresh client lineage, actual transport timeout,
  durable restart/retention и live остаются открытыми; in-process не заменяет UDS.

**Текущая волна: C2 запущена во всех шести задачах после приёмки C1.**
Runtime возвращён на Sol/high: усиленная модель применялась к ограниченной
доработке общего контракта. Acceptance остаётся Sol/medium.

- Runtime реализует настоящие authorities/journal/lease core, затем UDS/MCP.
- Native первым публикует единый pure method/protocol bridge и C1 mapping,
  чтобы Input/Capture не создавали несовместимые payloads.
- Input/Capture/Browser подключают production adapters к C1 и настоящим lower
  layers через injected test dependencies. Существующие сервисы пока не переключаются.
- Acceptance переносит сценарии с reference-моделей на реальные native/runtime
  реализации; отсутствие SUT не заменяется зелёным fixture-runtime.
- Новые package manifests готовят владельцы; root workspace/install выполняет
  ведущий после их handoff. C1 exports не меняются молча во время интеграции.

Владимир поручил ведущему выбрать экономную модель, способную выполнить работу.
Все задачи созданы в local environment проекта ai-macos: GPT-5.6 Sol, high для
реализации и medium для acceptance. Runtime первым публикует C1-кандидат.

| Направление | Task ID | Начальный этап |
| --- | --- | --- |
| Runtime, контракты и MCP | `01a0a240-53c3-70e1-bd8b-d9ad477ec98a` | C0 → кандидат C1 |
| Native broker и окна | `01a0a240-7df1-7780-b1d2-1126d33317b1` | C0 |
| Ввод и interaction | `01a0a240-86d1-7132-96c7-c2cae06376f6` | C0 |
| Снимки и координаты | `01a0a240-9258-7020-8725-a3054f9653cd` | C0 |
| Chrome и Android | `01a0a240-aa3c-7731-ac69-43b86c78bed6` | C0 |
| Приёмочные проверки | `01a0a240-b6e7-7203-ad6b-a36459d25db2` | C0 |

Владимир сообщил, что Android-телефон подключён. Это подготовка к M6/A39–A40,
не разрешение выбирать первое устройство, сбрасывать общий ADB daemon или
выполнять live input до готовности adapter и exact serial discovery.
