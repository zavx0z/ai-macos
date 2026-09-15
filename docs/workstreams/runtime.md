# Runtime, общие контракты и MCP

## Текущее состояние

Статус: C1 принят. C2 runtime core/evidence/continuation принят scoped ведущим.
C3 lifetime coordinator связан с RuntimeCore; текущий атомарный checkpoint
компилируется и проходит 34 runtime tests. Transport foundation принят scoped;
production catalog/cutover ещё впереди. Следующий checkpoint закрывает
quarantined/expired recovery и actual Android adapter composition.

## Checkpoint recovery и Android

- `BrowserLifetimeCoordinator.recover(session,bindingId,intent)` допускает только
  cleanup-only admin intent с exact quarantined reservation и active lineage.
  Registered host `recoverRemoval` выполняет физический cleanup, `verifyRemoved`
  подтверждает его в том же bounded lifecycle.
- Cleanup использует сохранённую reservation identity даже после expiry старой
  inventory. Public raw browser/device admission остаётся закрытым; разрешение
  stored-cleanup передаётся только private coordinator lifecycle.
- Runtime подготавливает старые unresolved journal records и exact quarantined
  leases до synchronous commit; после verified removal выпускаются cleanup
  receipts, сохраняется unknown effect и освобождаются старые resources.
- Replay прежнего recovery возвращает тот же результат. Новый запрос со старой
  target generation не снимает active reservation нового подключения.
- Actual `RuntimeDeviceBrowserAdapter` + `ForwardOwnedDeviceBrowserDriver` +
  `OwnedAdbForward` проверены на fake ADB/CDP dependencies: connect → reservation
  → second-connect rejection → child → failure/quarantine → exact forward
  removal/recovery. Системные ADB/CDP вызовы тест не выполняет.
- `bun test runtime/tests`: **35 pass / 196 assertions**.
- Root `bunx --no-install tsc --noEmit`: **exit 0**; `git diff --check`: **pass**.

Эти изменения готовы к scoped приёмке/коммиту. Следующий scope — production
MethodRegistry/server/adapter composition и journal persistence; полный релиз
этим checkpoint не объявляется.

## Checkpoint после resume Git

- `runtime/src/core.ts` вызывает private coordinated lifecycle: admission до
  adapter side effect, bounded verification/staging, synchronous reservation
  commit вместе с cleanup и quarantine при незавершённой операции.
- Public `runOperation` отклоняет browser/device domains без зарегистрированного
  private lifecycle до callback, включая `intent:read`. Прямой first/second
  connect не достигает adapter/driver. Транспортный echo fixture и проверка
  зависшего non-native verifier используют in-memory clipboard domain без OS I/O.
- `BrowserLifetimeCoordinator` держит exclusive connecting slot до connect,
  получает actual instance из результата собственного journal, вызывает verifier
  из immutable host binding и автоматически создаёт reservation. Child и
  disconnect проходят тот же coordinator.
- Публичная reservation authority предоставляет только assertChild/resume/inspect.
  Старые caller-owned reserve/release/verifier API удалены. Все обращения
  проверяют active session; expiry переводит reservation в quarantine.
- Device transport generations остаются структурированной парой полей.
- Тесты переведены на real RuntimeBrowserAdapter и автоматический lifecycle:
  second connect блокируется до driver, resumption/revoke/expiry и failed child
  проверены. Manual positive reserve/release orchestration удалён.
- `bun test runtime/tests`: **34 pass / 172 assertions**.
- `bunx --no-install tsc --noEmit`: **exit 0**.
- `git diff --check`: **pass**.

Оставшиеся lifetime части: отдельный runtime recovery для quarantined/expired
connection, actual Android coordinator composition и чтение inventory через
coordinator. Следующий production catalogue должен владеть этим routing; UI/MCP
слой получает только schema-derived descriptors и transport client.

Общая wire-модель теперь объявлена один раз на Zod 4.4.3. Из той же декларации
получаются runtime validation, TypeScript-типы через `z.infer` и JSON Schema для
MCP/reference. Старого manual parser/отдельного object-schema нет.

## C2 runtime core checkpoint

- Создан пакет `@meta/runtime` (`runtime/package.json`, `runtime/tsconfig.json`);
  ведущий добавил `runtime` в root workspaces и выполнил единственный install.
- `RuntimeCore` реализует authenticated client sessions/resumption, server-owned
  payload HMAC/dedup, operation journal/status/cancel, domain contexts, monotonic
  native fences, exact resource acquisition и runtime services.
- `ClientSessionRegistry` хранит только digests bearer/resumption credentials,
  связывает reconnect с principal и отзывает старый bearer/resumption token.
- `ResourceRegistry` является authoritative owner handles/cleanup receipts,
  сериализует общий desktop resource и оставляет unknown cleanup в quarantine.
- `TargetRegistry`, `ProofRegistry`, `ObservationRegistry` и `FrameStore`
  реализуют exact runtime-local authorities/cache; default capabilities не
  объявляют adapter ready без реального adapter/protocol evidence.
- Operation создаётся `registered` до adapter side effect с exact held leases,
  затем проходит `dispatching`; checkpoint проверяет AbortSignal, deadline и
  authoritative handles. Payload в journal не хранится.
- Dedup scope — runtime epoch + authenticated principal + clientRequestId:
  reconnect получает ту же operation/result, payload mismatch отклоняется.
- Exception после возможного dispatch даёт `interrupted-unknown`, quarantine и
  запрещает следующий dispatch на том же resource; blind replay отсутствует.
- Core тестируется через injected `NativeAdapter`, а не acceptance harness.
  Проверены два клиента, reply loss/reconnect, payload mismatch, cancel и unknown
  cleanup/quarantine.

Исправления после первого C2 review:

- dedup completed operation выполняется до new-admission deadline/target checks;
  fingerprint исключает новый deadline, поэтому reply receipt доступен после
  expiry/close target без replay;
- весь `AdapterResult`, correlated runtime-requested native status и staged
  terminal `OperationRecord` проверяются до all-or-nothing resource mutation;
- native/resource completion финализирует runtime, а не Input/adapter: complete
  cleanup требует свежий status query с exact operation/generation/fence,
  terminal native state и `heldCount=0`;
- deadline имеет runtime timer, AbortSignal, native cancel/status и bounded grace;
  зависший adapter переходит в unknown/quarantine, поздний callback не меняет
  settled journal;
- failure до adapter entry остаётся `dispatch:none/rejected` и безопасно
  освобождает leases; после adapter entry неструктурированная ошибка считается
  unknown;
- authoritative resource registry сравнивает все immutable issued fields,
  включая leaseGeneration, до любой mutation и не возвращает shared mutable refs;
- target registry проверяет deadline/current inventory TTL; native-bound proof
  требует native generation независимо от optional caller поля;
- late cleanup reconciliation принимает только correlated terminal native
  status либо registered completion verifier, monotonic revision и exact
  quarantined handles; runtime выпускает receipt, обновляет journal и снимает
  quarantine без изменения unknown UI effect/replay policy.

## UDS и thin MCP — source state

- `RuntimeUdsServer` слушает только Bun Unix socket, создаёт private directory
  `0700`, socket/credential `0600`, не заменяет preexisting paths и проверяет
  bearer до чтения invoke body.
- Bootstrap/resumption credentials дают отдельные authenticated MCP sessions;
  forged token не достигает executor. Request body читается streaming с 1 MiB
  cap до JSON/Zod.
- `RuntimeUdsClient` поддерживает open/resume, health, invoke, operation status и
  cancel. UDS retry после resume возвращает ту же operation.
- `mcp/src/runtime-mcp.ts` — import-safe thin MCP над UDS: пока только
  `system_health`, `get_operation`, `cancel_operation`; raw invoke/REST fallback
  в agent catalog не публикуется, runtime автоматически не запускается.
- `mcp/package.json` объявляет `@meta/runtime`; ведущий выполнил root install.
- Эти source/tests не означают cutover: launcher, installed services, helper,
  LaunchAgent и Codex config не менялись.

Transport rework после отдельного review:

- fresh session получает отдельную runtime-private lineage; resumption сохраняет
  family, а fresh MCP с тем же OS principal не видит и не отменяет чужие
  operation/dedup receipts;
- UDS client имеет connect/request/response timeout и bounded body; unknown invoke
  delivery выполняет lookup по clientRequestId и возвращает typed unknown, не replay;
- 401/404/operation status разбираются отдельно и successful record проходит
  `operationRecordSchema`;
- startup write/chmod/bind/socket-chmod находится в одном owned rollback;
  preexisting foreign credential не удаляется;
- request/response readers на timeout/overflow cancel stream и release lock;
  health различает active/total journal и quarantined resources.

Этот transport scope имеет isolated source tests, но production methods/frame
delivery/dynamic catalog/list_changed/cutover остаются следующими gates.

## C3 browser/device lifetime reservations

- `LifetimeReservationRegistry` владеет connect→disconnect reservation отдельно
  от короткого operation lease: exact instance/device generations, runtime
  lineage, expiry, status revision и active/quarantined/released state.
- Fresh client того же principal не наследует reservation; authenticated
  resumption той же lineage сохраняет её.
- Browser/device child operation проходит `AdapterServices.reservations` только
  при exact active instance generation; retarget/list failure/unknown переводит
  reservation в quarantine.
- Disconnect/ADB forward cleanup освобождает reservation только после injected
  authoritative removal verifier. Cleanup receipt idempotent; old
  reservationGeneration/externalGeneration не освобождает новую reservation.
- Real `RuntimeBrowserAdapter` composition проверяет connect → runtime reserve →
  child open target → disconnect → verified release. ADB authority test проверяет
  exact serial/USB+browser generations и owned forward removal.
- Идентичный внешний ABA, который сам внешний transport не различает новым
  generation/evidence, остаётся явным ограничением вне runtime control; runtime
  не делает fallback на первое устройство/target.

## Реализовано после первого C1 review

### Единая JSON-граница

- `contractSchemaRegistry` перечисляет публичные wire schemas; каждая успешно
  экспортируется через `contractJsonSchema`/`z.toJSONSchema`.
- `parseWireJson` и `parseWireValue` перед Zod отвергают prototype-like keys,
  `Date`, `Map`, class/non-plain objects, `undefined`, sparse arrays, cycles,
  циклические object refs, non-finite и unsafe integer values, не меняя объект
  transform-ом. Default 1 MiB/depth 32 проверяется итеративно до Zod; raw JSON
  byte budget проверяется до `JSON.parse`. Ограниченный override не может
  превышать 64 MiB/depth 128.
- Все DTO используют `z.strictObject`/discriminated unions. ISO timestamps
  требуют timezone. Native JSON ограничен одним MiB и depth 32.
- Generic native-bound ASCII ID ограничен 127 символами для C capacity 128 с
  завершающим NUL; generation ID — 64 символами с запасом для suffixes.

### Generations, targets и domain contexts

- `RuntimeGeneration` навсегда связывает `runtimeEpoch + loginSessionId`;
  `NativeGeneration` добавляет helper generation, `FenceToken` содержит все три
  значения и monotonic counter.
- Process/window/surface/element/display/browser/device/clipboard refs имеют
  структурированную identity. Browser target — exact instance + transport
  generation + target ID; Android target дополнительно сохраняет serial,
  device transport и browser transport generations.
- `SerializableOperationContext` — tagged union:
  `NativeExecutionContext`, `BrowserExecutionContext`,
  `DeviceExecutionContext`, `ClipboardExecutionContext`. Только native context
  требует `nativeGeneration + fence`; browser/device/clipboard не зависят от
  desktop helper.
- `TargetPrecondition` сохраняет structured target и inventory/observation
  revisions. `TargetAuthority` является обязательным runtime-local resolver;
  совпадение строки/URL/title не является authority.
- Native mutation envelope связывает request, operation, structured target,
  runtime/login/native generations, fence и deadline. Read envelope не получает
  mutation context.

### Client authority, resources и adapters

- `RuntimeClientSession` содержит authenticated principal/session, auth
  generation, runtime/login generation и expiry. `RuntimeAdapter.run/get/cancel`
  всегда получает session; dedup scope нельзя выбрать произвольным ID.
- `RuntimeOperationIntent` не принимает payload HMAC от caller. Runtime получает
  payload как значение операции и сохраняет собственный keyed `PayloadReceipt`.
- `RuntimeResourceHandle` связан с client/principal, operation, runtime/login,
  lease ID/generation, expiry и state. Структурная проверка не заменяет
  `ResourceAuthority.assertActive/assertOwnedSet`.
- `CleanupOutcome` — exact partition operation-owned handles на released и
  quarantined. Пустой/чужой/изменённый handle, overlap или потеря ресурса
  отклоняются уже `OperationRecord` schema. Освобождение требует не boolean, а
  `CleanupAuthorityReceipt` с operation/runtime/login и точным набором
  lease ID/generation плюс успешную проверку `CleanupAuthority`.
- Видимая browser activation представлена только как
  `activate-visible-target` и всегда требует `desktop-input + cdp-target` leases;
  caller не передаёт обходной boolean.
- Immutable `AdapterHostContext` и runtime-local `AdapterServices` предоставляют
  client/resource/target/proof authorities, observation resolver и
  `BinaryFramePublisher`.
- Интерфейсы: `RuntimeAdapter`, `NativeAdapter`, `WindowAdapter`, `InputAdapter`,
  `ClipboardAdapter`, `ScreenAdapter`, `BrowserAdapter`,
  `DeviceBrowserAdapter`.

### Native lifecycle и operation outcome

- Held-input ledger snapshot не заявляет собственный digest. Durable sink
  вычисляет SHA-256 от `HELD_INPUT_LEDGER_CANONICAL_VERSION=1` bytes и возвращает
  ACK с request/operation/runtime/login/native/revision/digest/time. Проверяются
  ACK hash chain, sequence high-water, unchanged held entries, допустимые state
  transitions, отсутствие потери entries и двух active entries одного key/button.
- Native heartbeat/status/cancel/drain request/ACK содержат request ID и
  generations; cancel также возвращает тот же operation/fence. Helpers проверяют
  корреляцию поздних ACK.
- `NativeOperationStatus` содержит accepted/high-water fence, checkpoint,
  dispatch attempts, ledger revision, tri-state target verification, observer
  coverage и quarantine. Active status требует operation ID/fence; complete
  cleanup требует `heldCount=0`. `dispatching` принимает только accepted fence,
  равный current high-water; stale accepted fence допускает лишь stop/
  reconciliation/terminal state и всегда запрещает restore. Старый recovery ledger имеет отдельный
  `NativeRecoveryLedgerStatus`, а не выдаётся за current accepted fence.
- Observer events имеют cursor/sequence, source/synthetic tag, generations,
  lifecycle details и target. Coverage содержит start/current cursor,
  covered-from/through watermark, heartbeat, drops/gap; unavailable observer
  означает `userInterference: unknown`. Restore/lease extension получают decision
  context и разрешаются только при current generations, полном interaction
  interval, continuous input+focus coverage и bounded heartbeat lag.
- Operation state/outcome сохраняют независимые execution, dispatch, target,
  interference, observation, effect, cleanup и restoration measurements.
  Read-only completed `dispatch:none` допустим. Verified mutation требует
  verified target, реальный dispatch и effect proof. Known failure с unknown
  cleanup сохраняется как failed+quarantine и не получает replay/release.
- Typed `ContractError` содержит `replayAllowed`; unknown outcome, incomplete
  cleanup, binary mismatch и user interference запрещают automatic replay.

### Observation, capture и binary frame

- `ProofRef` связывает authority, exact subject, runtime/login/native generations,
  inventory/display revisions, issue/expiry. `confirmed Evidence` без proof
  структурно невозможен.
- Wire `Observation` больше не принимает producer-controlled
  `pointerActionable` и разделяет `captureTarget` от interaction target.
  `InteractionPointProof` связывает exact window/surface/element с конкретными
  observationId, frameRef, region, coordinate space и точкой/ограниченным rect.
  `ObservationResolver` выдаёт `authorized:true` только после proof authority,
  current generations/revisions/deadline и freshness/frame-age checks.
- Pure helper называется `mapObservationPointGeometry` и не является
  authorizer. Affine transform проверяется по bounds углов с допуском; stale,
  overlapping и foreign region отклоняются.
- Readiness содержит явную policy, уникальные required/disabled steps и typed
  outcomes. False/timed-out required step не может стать ready; skipped допустим
  только как `disabled-by-policy`; empty result готов только для explicit empty
  policy.
- Single-frame и stitched synchronization различены. Для stitched `maxSkewMs`
  выводится из region timestamps; future capture/region time отклоняется при
  authoritative resolution.
- Capture requests сохраняют source, exact target mapping, clip/fullPage,
  cursor, readiness и output policies. Whole desktop имеет явный layout target,
  selected displays и topology revision.
- Runtime выдаёт `ObservationPublication`; Screen получает exact display/window
  mapping и authoritative registry/CG-AX proof. Runtime `TargetAuthority`
  подтверждает фактические nativeDisplayId либо cgWindowId+ownerPid; свободное
  поле request не является authority. Browser/device viewport сохраняет точный
  instance/target, serial и оба transport generations.
- JSON содержит только frame identity/metadata. `verifyAndPublishBinaryFrame`
  сверяет actual byte length, PNG signature/IHDR dimensions и SHA-256 до передачи
  bytes в runtime-local `BinaryFramePublisher`. Header, observation, publication,
  caption/source/target/revisions обязаны совпадать.
- `ScreenCaptureResult.effective` связывает фактические clip/fullPage/cursor/
  scale/extent/bytes/readiness с requested policy и его более узкими budgets до
  вызова publisher. DOM/accessibility/console result отдельно проверяет вид,
  UTF-8/serialized bytes, nodes/events и truncated semantics.
- Browser target cleanup и nested capture-stream cleanup имеют разные owner scope;
  пересечение lease IDs отклоняется.

### Полные adapter surfaces

- `WindowAdapter`: полный `DesktopInventorySnapshot` с applications/windows/
  displays, completeness/errors/generations; show/focus/bounds/minimize/close
  transitions с requested/actual/partial; bounded AX inspection.
- Window records различают hidden/minimized/on-screen/Space/fullscreen/focus,
  CG-AX proof с exact window/cgWindowId/ownerPid/current inventory,
  advertised/permitted actions и причины unavailable. Новая modal surface
  обязана иметь те же generations/application и owner исходного окна.
- Browser/device inventory возвращает snapshots, не массивы: inventory ID,
  generation, timestamp, completeness/errors и exact owner relation.
- `BrowserAdapter`: connect/disconnect, targets, open/close/visible activate,
  navigate/reload/wait, DOM/browser accessibility, console и capture.
- `DeviceBrowserAdapter`: device state `connected/offline/unauthorized/
  disconnected`, owned/foreign/absent/unavailable forward, exact browser instance,
  connect/disconnect и target operations. `listTargets` принимает только полный
  `DeviceBrowserInstanceRef`.
- Connect/reconnect result обязан сохранить stable instance identity и создать
  новую transport generation; consumer не выбирает первое устройство/target.

### Canonical capability policy

- `CAPABILITY_SCHEMA_VERSION = "1"` проверяется literal schema.
- `CAPABILITY_POLICY` принадлежит runtime и задаёт canonical dependencies и
  action class для всех 31 capability IDs.
- Adapter capability set может быть ограниченным, но проверяется только как
  local readiness. End-to-end `capabilityIsReady` работает лишь для полного
  runtime snapshot со всеми IDs и canonical dependency graph.

## Реальные paths и exports

- Entrypoint: `shared/src/contracts/index.ts`.
- Registry/schema: `registry.ts`, `schema.ts`.
- Identity/capabilities/errors: `identities.ts`, `capabilities.ts`, `errors.ts`.
- Operations/resources/adapters: `operations.ts`, `resources.ts`, `adapters.ts`.
- Native lifecycle: `native.ts`, `native-lifecycle.ts`, `observer.ts`.
- Observation/capture: `observations.ts`, `capture.ts`.
- Window/browser/device: `window.ts`, `browser.ts`.
- Regression suites: `schema-boundaries.test.ts`,
  `authority-lifecycle.test.ts`, `observation-capture.test.ts`,
  `inventories.test.ts`.

## Manifest/export state

Ведущий уже добавил точную `zod: 4.4.3` dependency в `shared/package.json` и
обновил `bun.lock`; эти файлы runtime-задача не переписывала. После приёмки C1
ведущему остаётся опубликовать subpath:

```json
"exports": {
  ".": "./src/index.ts",
  "./contracts": "./src/contracts/index.ts"
}
```

Root re-export в `shared/src/index.ts` нужен только если ведущий хочет сохранить
единый root API:

```ts
export * from "./contracts/index.ts"
```

Root `package.json` для C1 менять не требуется.

## Точная delta для private native C mapping

Shared wire не принимает private C structs как публичный контракт. Для C2
NativeAdapter mapping потребует от владельца `native/**`:

1. Добавить `login_session_id` в `MetaFence` и executor epoch state; проверять
   его вместе с runtime/native generation в begin/checkpoint/heartbeat/cancel.
2. Расширить `MetaExecutorStatus` либо TS broker-owned reconciliation record:
   operation ID, accepted/high-water fence, last checkpoint, dispatch attempts,
   ledger revision, tri-state target verification/interference и held count.
   `cleanup:complete` допустим только при `held_count=0`; старый recovery ledger
   возвращается отдельным status старого generation.
3. Durable ledger callback принимает canonical version 1 snapshot без
   self-asserted hash, вычисляет SHA-256 над зафиксированными canonical bytes и
   ACK-ает request ID, runtime/login/native generations, operation, revision,
   digest и persistence time до post. Текущего bool `persist_ledger` недостаточно.
   Sequence high-water не переиспользуется; unchanged held entries сохраняются.
4. Observer bridge публикует start/current cursor, sequence, covered-from/
   covered-through watermark, heartbeat, drop/gap coverage, synthetic source/tag
   и lifecycle generation. Один enum state без decision-time lag/interval check
   не разрешает restore/lease extension.
5. Registry resolution, передаваемый в TS NativeAdapter, возвращает exact
   nativeDisplayId либо cgWindowId+ownerPid вместе с proof ID; request fields без
   совпавшего resolution не доходят до capture/window executor.
6. C string fields capacity 128 совместима с shared max 127 ASCII; generation
   input дополнительно ограничен 64. Silent truncation запрещён, mapping должен
   reject oversized input до копирования.

Эта delta передаётся native-owner через ведущего; runtime-задача native-файлы не
меняла.

## Evidence issuance seam для C2

Одобренная additive форма добавлена в public contracts и реализована в runtime:

```ts
type VerifiedNativeEvidenceReceipt = {
  evidenceReceiptId: string
  adapterInstanceRef: string
  backendBuildId: string
  runtimeEpoch: string
  loginSessionId: string
  nativeGeneration: string
  inventoryId: string
  inventoryRevision: number
  displayLayoutRevision: number
  observedAt: string
  factKind: "target-resolution" | "frame" | "point-hit"
  factSha256: string
}

interface BoundNativeEvidencePublisher {
  publish(report: NativeEvidenceReport): Promise<VerifiedNativeEvidenceReceipt>
}

interface EvidenceIssuer {
  issueTargetResolution(request: {
    receipt: VerifiedNativeEvidenceReceipt
    target: NativeOperationTarget
    nativeMapping: NativeTargetMapping
  }): Promise<ProofRef>

  issueFrameFreshness(request: {
    receipt: VerifiedNativeEvidenceReceipt
    observationId: string
    frameRef: string
    captureTarget: NativeOperationTarget
    frameSha256: string
  }): Promise<ProofRef>

  issueInteractionPoint(request: {
    operation: NativeExecutionContext
    receipt: VerifiedNativeEvidenceReceipt
    observationRef: ObservationRef
    interactionTarget: NativeOperationTarget
    imagePoint: Point
    expectedSpace: "macos-screen"
  }): Promise<InteractionPointProof>
}

type ResolveStoredObservationPointRequest = {
  operation: NativeExecutionContext
  observationRef: ObservationRef
  interactionTarget: NativeOperationTarget
  imagePoint: Point
  expectedSpace: "macos-screen"
}
```

`BoundNativeEvidencePublisher` создаётся runtime для конкретного уже
handshake-проверенного adapter instance и захватывает его build/generation;
report не может выбрать эти поля сам. Runtime сверяет registered backend,
inventory receipt и fact digest, затем `EvidenceIssuer` задаёт authority ID и
timestamps. Generic `mint({confirmed:true})` не публикуется.

Public `ObservationResolver.resolvePoint` принимает только
`ResolveStoredObservationPointRequest`; он сам читает stored observation,
получает point-bound proof через `EvidenceIssuer` и вызывает внутренний
`authorizeObservationPoint`. Input не получает proof factory и не передаёт
готовый `ProofRef`.

Реализация: `NativeEvidenceAuthority` сверяет report с зарегистрированными raw
native response bytes/digest и bound adapter build/generation; issuer сам задаёт
ID/time/expiry. `issueFrameFreshness` дополнительно требует уже опубликованные и
проверенные frame bytes/digest. `ObservationRegistry.resolvePoint` принимает
минимальный запрос, находит stored frame/point evidence и выпускает point-bound
proof внутри runtime.

## Выполненные checks

```text
bun test shared/src/contracts
49 pass, 0 fail, 238 expect() calls

bunx --no-install tsc --noEmit --strict --target ESNext \
  --module Preserve --moduleResolution bundler \
  --allowImportingTsExtensions --types bun \
  shared/src/contracts/index.ts shared/src/contracts/*.test.ts
exit 0

bun test runtime/tests
29 pass, 0 fail, 152 expect() calls

bunx --no-install tsc --noEmit -p runtime/tsconfig.json
exit 0

bun test mcp/tests/runtime-mcp.test.ts
1 pass, 0 fail, 2 expect() calls

bunx --no-install tsc --noEmit -p mcp/tsconfig.json
exit 0
```

Root `bunx --no-install tsc --noEmit` во время последнего checkpoint показывал
только соседний fixture drift: Android/Chrome/Input/Native/Screen test services
ещё не добавили новый `reservations` stub. Runtime/shared/mcp targeted typechecks
проходят; владельцы уведомлены через ведущего.

В том числе проверены все публичные schemas из `contractSchemaRegistry` на JSON
Schema export и контрпримеры первого C1 review: prototype/Date/Map/undefined/
sparse/cycle, не-ISO timestamp, unsafe number, oversized ID/envelope/depth,
  foreign target/generation, forged/revoked lease, incomplete cleanup partition,
  authoritative release receipt, late/digest ACK, two held keys, observer
  watermark/future heartbeat, held-after-complete, false readiness,
  future/stale frame, invalid transform/skew, composite→exact-window point proof,
  binary/request budget mismatch, browser content limits, foreign native display,
  window mapping/action/new-surface mismatch и depth-200 wire input.

Live input/capture/clipboard/Chrome/ADB, permissions, helper build/install и
запуск/перезапуск services не выполнялись.

## Acceptance по текущей границе

- A01/A10/A13: version/build/generation/fence и observer-degraded contracts
  покрыты pure tests; live часть остаётся ведущему.
- A06–A11: ledger/durable ACK, runtime cancellation/status, reply-loss dedup,
  deadline grace, unknown cleanup/quarantine и idempotent late reconciliation
  имеют real-core tests; native crash/watchdog integration ещё требует C2 owner wiring.
- A03–A05/A12: authoritative client/resource/target services и один runtime
  scheduler реализованы; physical user takeover остаётся live/native gate.
- A23/A25/A31/A34–A38: coordinate/capture/browser/device contracts и private
  authenticated UDS готовы в source/tests; production adapters/cutover не завершены.
- A42/A43/A45: in-memory journal/status/cancel и bounded control loop готовы;
  persistent restart journal, real MCP list_changed и slow-AX/native integration
  ещё не приняты.

## Следующий шаг

Ведущий повторно принимает C2 runtime/authority checkpoint. После acceptance
следующий согласованный scope — runtime-owned long-lived browser/device
reservations и child operation leases, затем persistent restart journal и
lifecycle supervisor. UDS/thin MCP source не переводится в production cutover до
готовых adapters. Installed services/helper/LaunchAgent/Codex config не менялись.
