# Native broker, приложения и окна

## Текущее состояние

C0 принят. C1 импортирован через публичный `@meta/shared/contracts`. C2
реализован в границе native core, framed transport/adapter, WindowAdapter,
Input/Capture bridges и проверяемых fake/runtime integrations; независимое
ревью ведущего продолжается.

Установленный `input/bin/meta-input-helper`, работающие services, TCC grants,
живые окна, ввод и захват не менялись и не запускались. Успешные compile/fake
checks не объявляются native/live acceptance.

## Реализовано

### C ABI v2 и executor

- `native/include/meta_native.h`, `native/src/executor.c`:
  - `META_NATIVE_ABI_VERSION=2`;
  - fence содержит `runtimeEpoch + loginSessionId + nativeGeneration + counter`;
  - accepted/high-water fence, exact operation ID, last checkpoint, tri-state
    target/interference, dispatch attempts, ledger revision и observer state;
  - target/fence/cancel/deadline checkpoint перед каждым event cluster;
  - `meta_executor_advance_fence` отзывает старую operation и запрещает restore;
  - watchdog останавливает будущие events; stale/retired epoch не возвращается;
  - synthetic tag включает runtime/login/native/operation/counter;
  - ошибки после confirmed down выполняют bounded matching up либо quarantine.
- `native/src/ledger.c`:
  - canonical held-input snapshot v1, monotonic sequence и hash chain;
  - SHA-256 bytes совпадают с `heldInputLedgerCanonicalBytes` из C1;
  - executor проверяет exact durable ACK identity/digest до `CGEventPost`;
  - atomic file replace, mode `0600`, `fsync` file+directory;
  - corrupt/foreign/unresolved ledger fail closed;
  - startup recovery публикуется отдельным old-generation status без blind up.
- `native/src/input_bridge.c`, `native/src/macos_input.m`:
  - готовый Unicode grapheme schedule из Input исполняется без второго planner;
  - RU/EN, emoji ZWJ и composed cluster сохраняются как exact UTF-16 units;
  - cancel/checkpoint между clusters, shortcut strokes и drag points;
  - hover/click/anchor scroll/trajectory drag сохраняют point, unit, flags и
    canonical modifiers; limits 5 s / 30 s проверяются до events;
  - macOS sink использует CoreGraphics events с synthetic source tag и не
    запрашивает Accessibility автоматически.

### Registry и macOS window backend

- `native/src/registry.c`, `native/src/macos_backend.m`:
  - process incarnation (`pid + start time + registration nonce`),
    `nativeGeneration`, невозвратные `applicationRef/windowRef/surfaceRef`;
  - all NSWorkspace applications, bounded AX inventory и CG `optionAll`;
  - `no-windows`, timeout, denied, unavailable и failed различаются;
  - CG-only entries сохраняются без выдуманного AX/window ref;
  - CG↔AX mapping только при двустороннем 1:1; many-to-one остаётся ambiguous;
  - sheets/surfaces имеют exact owner window relation;
  - display registry сохраняет negative origins, usable bounds, scale,
    rotation и отдельный topology revision;
  - Objective-C backend реализует exact show/unhide/unminimize/focus,
    bounds/minimize/close с readback и partial state.
- `native/src/serialization.m` переводит registry в strict raw protocol,
  сохраняет CG-only/surfaces и отклоняет неизвестную capture orientation.

### Protocol, adapter и evidence

- Package exports:
  - `@meta/native`
  - `@meta/native/protocol`
  - `@meta/native/adapter`
  - `@meta/native/window-adapter`
  - `@meta/native/capture-client`
  - `@meta/native/evidence-extractor`
- `native/src/protocol.ts`:
  - C1 envelope creators для `window.inventory`, `window.transition`,
    `ax.inspect`, `input.execute`, `capture.start`;
  - lifecycle status/heartbeat/cancel/drain и cleanup-only continuation;
  - two-phase capture `start → taskRef → result/status/cancel/release`;
  - 4-byte big-endian framed JSON, отдельный bounded binary payload без base64;
  - full inline `NativeOperationStatus`, hard input/capture budgets,
    orientation `display-oriented`.
- `native/src/adapter.ts`:
  - persistent `NativeProcessTransport` и multiplexed request/event/ledger/
    cleanup/binary routing;
  - late response после local deadline не переигрывает operation;
  - exact response correlation, canonical ledger ACK bridge и binary limits;
  - `adapterInstanceRef` задаётся конфигурацией; `loadedBuildId`, generation и
    evidence binding появляются только после совместимого handshake.
  - decoder читает и проверяет 4-byte header до allocation: JSON ≤1 MiB,
    binary ≤64 MiB; большой входной chunk целиком не копируется;
  - одновременно допускается до 128 requests, 4 binary waiters/128 MiB;
    request IDs имеют 10 000/24 h tombstone и не переиспользуются;
  - event queue ограничена 1 000 events/1 MiB; overflow очищает очередь и
    возвращает явный observer coverage gap вместо молчаливой потери.
- `native/src/evidence-extractor.ts`:
  - normalizes authoritative facts только из exact raw response bytes;
  - display target, `window-cg-ax-correlation`, capture task start/status/
    terminal и frame;
  - регистрирует все schema-owned distinct source refs одного response;
  - `createRuntimeNativeEvidenceBinder` связывает extractor/response bytes/
    bound publisher с реальным Runtime authority и проверенным build identity.
- `native/src/window-adapter.ts`:
  - реализует shared `WindowAdapter`;
  - сохраняет AX windows, все surfaces и CG-only records;
  - публикует runtime-issued CG/AX proof, не producer proof;
  - window `NativeTargetMapping.displays` — exact positive-intersection set на
    текущей topology revision, включая spanning window.
- `window/src/adapter.ts` публикует `@meta/window/adapter` без дублирования.

### Capture lifecycle и generic cancel

- `native/src/capture_router.m`:
  - synchronous accepted task identity до async `SCStream` completion;
  - status/cancel/result/release одного taskRef;
  - unknown→complete reconciliation без второй completion;
  - release только после drain или runtime recovery authority;
  - `NSCondition` + in-flight lifetime защищают native task/result от
    concurrent status/result/cancel/release; result-view требует `result_done`;
  - release tombstone сохраняет exact cleanupRequestId, operation/task,
    runtime/login/native generations, accepted/high-water fences, status,
    drained evidence и terminal receipt;
  - hard-128 eviction удалён: до 10 000 tombstones на runtime journal horizon,
    затем новые tasks fail closed; удаление только отдельным
    `forget_released` с совпавшим authoritative receipt;
  - taskRef не переиспользуется; duplicate release возвращает тот же receipt и
    `alreadyReleased` без обращения к освобождённому native state.
- `native/src/broker_core.c` связывает generic operation cancel с
  `meta_executor_cancel_operation` и
  `meta_capture_router_cancel_operation`: потерянный start ACK не оставляет
  незримый task вне operation cleanup. Operation status сохраняет task/drain/
  result evidence; release выполняется отдельно после authoritative terminal.
- `native/src/capture-client.ts`:
  - регистрирует accepted task в реальном Runtime continuation registry;
  - промежуточный status advances только для nonterminal revision;
  - первый complete+drained status сразу делает single terminal transition;
  - failed/cancelled result без frame также получает terminal lifecycle;
  - frame proof отделён от cleanup proof;
  - lost release ACK повторяется с тем же cleanupRequestId и новым RPC requestId,
    после чего принимается `alreadyReleased` tombstone.

### Build/update safety

- `native/scripts/build.sh` собирает единый dylib из registry/executor/window/
  input/router и capture-owned `native/src/capture/meta_capture.m`.
- Общий link использует Objective-C ARC/blocks, macOS 13 и frameworks
  Foundation, AppKit, ApplicationServices, CoreGraphics, CoreImage, CoreMedia,
  CoreVideo, ImageIO и ScreenCaptureKit.
- `input/src/native.ts` больше не компилирует и не подписывает установленный
  helper на bootstrap. Отсутствующий/stale helper требует явный согласованный
  `apply-update`; путь/TCC identity не меняются автоматически.

## Стабильные C signatures

- `meta_executor_open_runtime_epoch(executor, runtimeEpoch, loginSessionId)`
- `meta_executor_begin(executor, operationId, targetRef, fence, deadlineMs)`
- `meta_executor_checkpoint(executor, stage)`
- `meta_executor_advance_fence(executor, highWaterFence)`
- `meta_executor_cancel_operation(executor, operationId, acceptedFence)`
- ledger callback:
  `persist_ledger(context, MetaLedgerPersistenceRequest*, MetaLedgerPersistenceAck*)`
- `meta_executor_restore_ledger(executor, MetaHeldInputLedgerSnapshot*)`
- `meta_executor_recovery_status(executor)`
- `meta_capture_router_cancel_operation(router, operationId)`
- `meta_capture_router_result_done(router, taskRef, result)`
- `meta_capture_router_release_authorized(router, authority, receipt)`
- `meta_capture_router_forget_released(router, receipt)`
- `meta_broker_core_cancel_operation(broker, operationId, acceptedFence)`
- `meta_broker_core_operation_status(broker, operationId)`
- `meta_broker_core_release_drained_operation(broker, operationId, recoveryAuthorized)`

## Выполненные checks

```text
bun run --cwd native test
# 7 C/Objective-C fixtures pass
# 28 TS tests, 133 assertions pass

bun test tests/computer-use/native-sut.test.ts \
  tests/computer-use/contracts-sut.test.ts \
  tests/computer-use/matrix.test.ts
# 23 pass

bun run --cwd screen test
# 33 pass, 163 assertions

bun test input/tests/action-plan.test.ts input/tests/native-action.test.ts \
  input/tests/adapter.test.ts input/tests/native-integration.test.ts \
  input/tests/authorization.test.ts input/tests/keys.test.ts \
  input/tests/window-selector.test.ts
# 48 pass, 96 assertions

sh native/scripts/build.sh /tmp/meta-native-build.*/libmeta-native.dylib
# Mach-O 64-bit dynamically linked shared library x86_64
# required capture/window/input frameworks linked
```

Ключевые проверенные последовательности:

- real C SUT: A04, A06–A10, A16;
- real Runtime evidence authority: all-window mapping, CG-only, surfaces и
  spanning window на двух displays;
- real Runtime continuation registry: capture start1 → pending2 → pending3 →
  terminal4 → identical terminal4 → normal release;
- потерянный release ACK: новый RPC request ID, прежний cleanupRequestId,
  `alreadyReleased` без доступа к освобождённому state;
- конкурентные status/result-view/cancel/duplicate release не освобождают
  native task или result до окончания in-flight call;
- первый release tombstone остаётся idempotent после 130 последующих releases;
- потерянный capture start ACK: generic operation cancel останавливает executor
  и все связанные capture tasks, late completion остаётся доступным по operation
  до drain/release.

## Manifest delta

- Ведущий уже добавил `native` в root workspaces и обновил `bun.lock`.
- `native/package.json` зависит от `@meta/shared` и публикует перечисленные
  subpath exports.
- `window/package.json` зависит от `@meta/native` и публикует `./adapter`.
- Дополнительной установки dependencies native-задача не выполняла.

## Remaining production/live requirements

- Нет установленного production broker executable/supervisor cutover: C core,
  dylib, TS process transport и temporary framed helper проверены, но старые
  REST services ещё не заменены runtime-owned helper process.
- Production command/event loop должен связать `MetaBrokerCore`, macOS backend,
  observer events и capture router с теми же protocol frames; standalone fake
  broker не является установленным daemon.
- Полный AX tree pagination/actions, actual CGEvent observer coverage
  (focus/window/lifecycle watermarks) и slow-AX concurrent cancel/health требуют
  следующего production wiring/fault pass.
- Launch/quit application и unsaved-dialog live behavior ещё не подтверждены.
- Native show/focus/bounds/minimize/close, hidden/other-Space, mixed-DPI,
  ScreenCaptureKit quality, physical user takeover, sleep/wake/login change,
  TCC update/rollback и actual input routing требуют ведущего live matrix.
- Platform code, installed helper, permissions и работающие процессы не
  изменялись. Поэтому `desktop.core` и `capture` ещё не объявляются live-ready.
- Последний root `tsc --noEmit` после native-green падает только в текущем
  `runtime/src/transport.ts:396,450` на типе Bun reader `readMany`; это передано
  runtime-owner и не исправлялось из native scope.

## Следующий шаг

### Audit session metadata checkpoint

Production `--metadata`, `--doctor` и framed handshake теперь содержат `session`
из `getaudit_addr`, `getuid`, `geteuid` в исполняемом helper. При syscall failure
или unassigned audit session возвращается `verified:false` с reason; caller
environment не подставляется. При verified identity native admission сравнивает
login label с `audit:<uid>:<auditSessionId>`. RuntimeHost отдельно проверяет
actual handshake session перед readiness; parent-process audit comparison пока
не заявлен.

`build-broker.sh` связывает `session_identity.c` и `libbsm`. Временный production
candidate с ID `native-audit-metadata-check` собран, не запускался. Command-loop
fixture возвращает явно unverified mock session, не вызывает audit syscall:
8 tests / 33 assertions pass. `git diff --check` проходит.

### Async command loop и keyboard checkpoint

`command_loop.m` теперь использует `MetaBrokerTransport`: control queue отдельно
от последовательной action queue, main NSRunLoop продолжает работать. Slow AX
inventory не удерживает heartbeat/drain. При занятой action queue новый action
отклоняется; requests не копятся в скрытом scheduler.

`MetaInputExecutor` владеет постоянным C executor только на action thread.
`MetaInputJob` передаёт atomic cancel и immutable status snapshots через
`NSCondition`; durable ledger ACK ждёт отдельная bounded condition. TS adapter
продолжает читать control responses, пока ledger sink сохраняет snapshot.
Дополнительный checkpoint после down ledger ACK предотвращает post после
полученной отмены; неопределённая pending entry сохраняет quarantine.

Production handlers `input.execute` для key/text подключены к CoreGraphics sink,
exact focused AX target и текущему inventory ID/revision; status/cancel читают
job snapshot и меняют только cancel signal. Pointer/shortcut, capture и window
transitions ещё остаются последующими handler slices.

Проверки: 8 C/Objective-C fixtures pass; adapter + command-loop suites —
12 tests / 36 assertions pass. Настоящий command loop с injected sink проверяет
cancel между Unicode clusters и heartbeat/cancel во время ledger ACK wait.
Production executable собирается с build ID `native-concurrent-input-check`,
но не запускался. Targeted tsc и diff check проходят.

Scoped async review исправил три случая: input focus использует exact
`CFEqual(focused, target)` и больше не принимает родительское окно вместо
focused sheet; rejected ledger sink переводит adapter в `poisoned`, закрывает
transport и немедленно отклоняет status/cancel; native failures отображаются
из C status как target-stale/failed, resource-quarantined, cleanup-incomplete
или cancelled. Если C executor уже принял operation, коррелированный status
сохраняется и при begin-time verification failure.

После исправлений adapter+command-loop: 15 tests / 49 assertions pass.
Cancel ACK с `stopped:false` подтверждает лишь запрос. После последующего
`stopped:true, cleanup:complete` дополнительная status-проверка подтверждает
неизменность dispatch counter. Production candidate пересобран, но не запущен.

### Первый executable checkpoint

`native/scripts/build-broker.sh <temporary-candidate-output> <build-id>` теперь
собирает Mach-O x86_64 executable, связывая command loop, native modules и
clipboard ABI. Путь установленного helper script отвергает. Сборка выполнена
в `tmp/native-window-check/meta-native-broker`, build ID `native-command-check`;
сам production binary не запускался.

Новые `native/src/command_loop.m` и `native/src/broker_main.m` реализуют
framed handshake, проверку actual loaded build/generation, read-only inventory,
clipboard channel, heartbeat и закрытие admission при drain. Параметры
`--metadata` и `--doctor` предусмотрены для root installer: doctor вызывает
только passive Accessibility/post-event/Screen Recording preflight из helper.
Действующие C1 clipboard operation DTO переиспользуются без native fence.

Проверка `native/tests/command-loop.test.ts`: 2 pass, 5 assertions. Исполняется
production command loop с injected `FixtureCommandBackend`; системный
clipboard/AX/capture/input не вызывается. Targeted TypeScript check и
`git diff --check` проходят.

Это первый executable slice: input, window transitions, capture task/cleanup,
generic operation status/cancel и observer handlers ещё требуют wiring.
Неизвестные методы возвращают `unsupported-capability`; candidate не готов
для installed cutover. Root installer должен дождаться оставшихся handlers.

### Проверенный checkpoint после resume

`native/src/session-lifecycle.ts` проверен через настоящий `NativeBrokerAdapter`
с injected framed transport. После 9 000 запросов health состояния session
сообщает `rotation-required`; runtime сохраняет terminal receipts после
коррелированного complete drain, закрывает старый transport, создаёт новый
handshaken instance/generation и выполняет invalidation/reinventory. Unknown
drain и pending binary запрещают replacement. Последние 128 drain IDs имеют
отдельный hard bound; callback authority не создаётся внутри adapter.

Проверки этого небольшого checkpoint:

- `bun test --cwd native tests/session-lifecycle.test.ts tests/adapter.test.ts`
  — 10 pass, 29 assertions, включая pre-aborted no-send/no-waiter.
- Targeted `tsc` для этих implementation/test files — pass.
- `git diff --check` — pass.

Ещё требуется production C quiescence/rotation path и его wiring в runtime
factory; этот checkpoint не объявляет завершение всего retention lifecycle.

Следующий C checkpoint добавляет `meta_broker_core_begin_rotation` и
`meta_broker_core_seal_for_rotation`. Begin безусловно и необратимо закрывает
обе admissions независимо от готовности executor/router; возвращает
`SEALED_PENDING` до quiescence и `READY` после неё. Обе проверки выполняются
без short-circuit. Проверяются active/unknown/held input, released tasks,
callback_pending, in-flight calls, borrowed results и ongoing cleanup.
Только после этой проверки
старый router можно уничтожить и создать новый с другой native generation.
Старые operation receipts остаются у runtime.

`sh native/scripts/check.sh` — 8 C/Objective-C fixtures pass. Новый
`rotation_horizon_test.m` выполняет 10 000 capture/release cycles, сохраняет
первый tombstone, проверяет stop admission на cap, controlled retirement и
новую generation без старых refs. Отложенный callback после drained/release/
destroy блокирует seal до завершения callback. `git diff --check` — pass.
Regression проверяет active capture → sealed-pending → запрет новых input и
capture → cancel/callback/release → ready. Command-loop drain ACK и actual
runtime replacement factory wiring остаются
следующим отдельным checkpoint.

Ведущий принимает C2 diff и определяет cutover production broker executable.
После него native-owner связывает общий command/event loop с уже проверенными
`MetaBrokerCore`/registry/input/capture modules, затем ведущий выполняет C3 live
checks без автоматического permission request или замены helper.
