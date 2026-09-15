# Runtime, общие контракты и MCP

## Текущее состояние

Контракты, durable core, UDS/MCP, host lifecycle и scoped recovery приняты
несколькими проверенными checkpoint. Production cutover пока не выполнен.
Остаются полноценная host-интеграция observer/readiness/interaction,
startup recovery receipts и управляемая rotation; pointer readiness не
объявляется по одному факту наличия C dispatch.

## Последующий проверенный integration slice

Базовая high-level Host composition подключена:

- Один AgentTargetRegistry и один AgentViewGuard/AgentViewBindings используют
  sole observer hub. Actual helper требует negotiated RecoveryDomain v1 и
  ViewAdmission v1; Native authorizer связан с actual Core operation до первого
  ввода. Пока observer/view gate не готовы, protected methods не доступны.
- Public get_state/observe/show_window, status/cancel, check_input и guarded
  keyboard/pointer/AX registrars подключены к host. Service input/AX methods
  internal и не вызываются по угаданному имени снаружи. Специализированные
  browser/Android, app/window lifecycle и capture сохраняются; list_displays
  оставляет exact display discovery для специализированного capture.
- press_shortcut исполняет bounded sequence одной Core operation через настоящий
  Guard/Bindings в тесте; cross-operation continuation отсутствует. Новый вызов
  требует fresh observe. Hover уже предоставляется pointer registrar.
- Runtime view rejection после durable grant не превращается в quarantine,
  если зарегистрированная Native delivery authority доказывает zero mutation
  sends. Core возвращает failed/cancelled receipt с complete cleanup; attempted
  delivery не получает этот shortcut. Проверен actual Core/Input/NativeAdapter.
- Последний runtime + thin MCP run: **283 pass / 1319 assertions**. Diff-check
  чистый. Latest typecheck остановился на двух ошибках в параллельном guard
  display-target extension; предыдущий scoped typecheck проходил.
- Native C atomic gate acceptance и coverage surfaces/display pointer остаются
  отдельными final gates. Это не полный live acceptance и не installed cutover.

Domain recovery и restart-liveness:

- Новый DomainRecoveryStore использует весь persisted possible-hold set, а не
  только уже появившиеся ledger entries. Unicode key0 без ledger и частичный
  prefix shortcut проходят positive ALL-UP recovery после actor exit.
- Sidecar связан с exact grant/hash, actor identity, readiness facts и optional
  неизменным ledger snapshot. Исходный ledger и effect не переписываются;
  unknown/held response не снимает quarantine. Повторное чтение receipt
  подтверждает fsync файла и каталога.
- Host передаёт operation journal в recovery. Вызов не попадает в dead-end
  поиска только ledger-backed операций; успешный domain probe не вызывает
  второй legacy probe.
- Managed rotation при current actor failure/operation quarantine имеет
  отдельный путь `restart-safe-quarantined`: durable journal retention →
  cleanup owned browser resources → confirmed owned Native exit → durable
  restart receipt. Обычный admin drain сохраняет требование complete cleanup.
  Историческая startup quarantine сама по себе не запускает restart loop.
- `check_input` использует trusted internal dispatch readiness registrar;
  actual Core test проверяет точные inventoryId/revision, status query и release.
- Проверки rotation/startup recovery/host SIGKILL: **9 pass / 50 assertions**;
  check_input/startup/domain core: **11 pass / 82 assertions**. Это injected
  Native replies и process fixtures, не live input acceptance. Native C probe
  и final high-level/guard composition остаются отдельными verification gates.

RecoveryDomain v1 — первый внутренний checkpoint:

- В operation journal добавлен atomic gate `not-authorized` → `send-authorized`.
  Grant содержит descriptor, SHA exact context/descriptor и durable revision;
  Native получает его только после fsync и повторной проверки active context.
- Legacy operation не может задним числом получить доверенный marker;
  authorized descriptor неизменяем, переход назад и выдача нового grant terminal
  operation запрещены. Plaintext input не входит в descriptor.
- Actor metadata сохраняет negotiated recovery version. `not-authorized`
  допускает no-send recovery; no-held authorization требует доказанного actor exit.
  Effect не становится verified, для незавершённого authorized dispatch
  restoration/dispatch остаются unknown. Старый cursor не восстанавливается.
- Existing ledger probe подходит только если реальный ledger покрывает весь
  declared risk set. Missing marker, несогласованный ledger и Unicode key0 без
  нужного domain probe не превращаются в cleanup complete.
- `retainForRecoveryRestart` и отдельный `prepareQuarantinedRestart` сохраняют
  quarantine перед завершением owned helper. Receipt называется
  `restart-safe-quarantined` и не содержит ложного `cleanup:complete`.
- Положительные process-crash/no-ledger и retention/late-exit проверки входят
  в **29 pass / 148 assertions**; scoped runtime typecheck и diff-check прошли.
- Native before-send/C-validator, domain risk-set probe и production Host activation
  ещё согласуются с владельцем. Production marker до этой связки не включается;
  per-character fsync и unsafe legacy inference не добавлены.

Следующий внутренний host/recovery срез:

- Managed rotation подключена к `META_RUNTIME_MANAGED=true`: Native budget
  8500, frame reference budget 9000 или 23 часа вызывают seal → подтверждённый
  drain/close → exit. Без supervisor остаётся `restart-needed`; drain/close
  coalesce, а неизвестный cleanup запрещает замену процесса.
- UDS поднимается до observer preparation. Host сначала получает свежую native
  inventory, затем готовит sole PUSH binding и проверяет coverage. Health
  различает preparing/ready/unavailable; continuity не выдаётся за unlocked.
- Startup-held recovery сохраняет отдельный immutable receipt в audit partition.
  Original ledger snapshots не меняются. Требуются exact ledger digest/revision,
  подтверждённый actor exit и свежий Native ALL-UP с положительными permission,
  active-console, SecureInput и observer predicates.
- Core обновляет только cleanup старой desktop-input operation, сохраняя effect
  и историческую неопределённость. Повторный startup использует receipt без
  нового probe. Historical unknown effect с complete cleanup не блокирует admission.
- Внутренний owner-scoped recovery и отдельный admin recovery проверяют authority;
  public naming не фиксируется до нового CUA-compatible façade основной задачи.
- Targeted recovery/rotation/transport: **13 pass / 77 assertions**; дополнительный
  host/registry/crash/capability run: **9 pass / 55 assertions**.
  Diff-check прошёл. Последний общий typecheck остановился на трёх ошибках
  в параллельно изменяемом native/tests/capture-command-loop.test.ts
  (`AsyncIterable.next/return`, `coverage.startCursor`). Durable lifetime и полное readiness/
  interaction wiring продолжаются в согласованных владельцах.

- State физически разделён по `state/login-<sha256(audit)>/`: credentials,
  operations, held-input и native-actors не смешиваются между login sessions.
  Старые flat development files не удаляются и не импортируются автоматически.
- Active point provider проверяет exact operation, session, desktop lease,
  frame hash и ownership observation по lineage до и после Native query.
  Raw-backed provider подключён к host; proof выпускает ObservationRegistry.
- Native mutation delivery authority регистрирует контекст до callback.
  Failed predispatch с доказанным отсутствием mutation send освобождает lease
  без запроса несуществующего Native job. Без authority остаётся quarantine.
  Проверен настоящий RuntimeCore → DesktopInputAdapter → NativeBrokerAdapter
  с fake transport, а не только adapter stub.
- Client close/expiry запускают ограниченный grace cleanup своей lineage;
  ранний resume отменяет ожидание. Host drain дожидается cleanup и закрывает
  owned browser connections через проверенный coordinator.
- После смены host epoch клиент автоматически повторяет только безопасное
  чтение после 401 и подтверждённого resume. Mutation POST не повторяется.
- Native actor journal сохраняет verified handshake process identity.
  Quiescence подтверждается owned child exit либо ESRCH; живой/reused PID
  остаётся unknown. Exit — ещё не доказательство освобождения held inputs.
- ALL-UP DTO отделяет active-console, SecureInput и lockState; unknown lock
  не переименовывается в unlocked. Старый ledger не переписывается.
- Rotation coordinator отдельно проверен на seal → drain → close → exit и
  запрет exit после late/hung drain или close. Host wiring ещё не завершён.
- Последний общий run: **184 pass / 767 assertions**, root typecheck и
  diff-check прошли. После него добавлена проверка lineage в point hook;
  она требует повторной focused проверки перед приёмкой этого slice.
- `runtime.install` принадлежит внешнему installer; его отсутствие в MCP
  не подменяется ready-константой. Функциональный UI/browser readiness
  проверяется отдельно от artifact/signature/launchd/admin transaction.

## Checkpoint durable core и host integration

Проверенный lifecycle checkpoint:

- Host использует kernel lease и проверенную очистку stale socket/credential до
  запуска metadata/helper. Новый integration test принудительно завершает
  RuntimeHost через SIGKILL, проверяет оставшиеся артефакты и подтверждает
  успешный новый host с прежней lineage после resume.
- ClientRenewalCoordinator обновляет credential между calls, до expiry или до
  длинного метода. Concurrent renew coalesces; active call не теряет bearer.
  Runtime запрещает resume при ещё active operation этой lineage. Resumption
  inactivity TTL отделён от пятиминутного bearer и ограничен 24 часами.
- Explicit UDS close останавливает renewal/catalog polling, сообщает disconnect
  runtime и ждёт остановки active calls. Thin MCP закрывает свой runtime client;
  doctor также освобождает временную session. Browser lifetime grace cleanup
  ещё требует отдельной интеграции.
- Host heartbeat: один in-flight request, interval 250 ms, deadline 500 ms;
  failure закрывает admission, drain/close останавливают цикл. Heartbeat IDs
  имеют отдельное bounded окно 128 IDs/5 секунд и не исчерпывают 24h action IDs.
- FrameStore ограничен глобально 64 кадрами/128 MiB, по 4 на lineage; expiry
  удаляет байты и publication metadata. Bounded issued-reference tombstones
  запрещают повторную публикацию после eviction. Proof/observation metadata
  имеют capacity и очистку expired записей; browser proof не связывается с
  native generation смешанного host.
- Host подключает owner registrars Input/Capture/Browser, но pointer/drag
  остаются unavailable до настоящего readonly point-hit evidence provider.
  Browser endpoints задаются только явным host config; Chrome не запускается,
  Android остаётся explicit opt-in. Window и capture readiness берутся из
  реальных declared Native capabilities.
- Последний полный runtime + thin MCP run: **129 pass / 618 assertions**;
  root typecheck **exit 0**, diff-check **pass**. После него pointer/drag были
  оставлены fail-closed до production point-hit цепочки; изменение только
  capability allowlist.

Restart credentials и пассивная идентичность helper:

- Private client state хранит HMAC key generation, ключ, hashes bearer/resumption
  credentials и exact lineage/session metadata. Checksum, private mode, UID,
  запрет symlink и размер проверяются при чтении; запись использует atomic fsync.
- Host подтверждает запись credential до ответа open/resume. Зависшая запись
  ограничена durable deadline и закрывает admission. Обычный sync open запрещён
  в durable host; operation требует подтверждённую durable session.
- После restart старый bearer не действует. Resumption token подтверждает прежнюю
  lineage в той же login session и выдаёт новый bearer/current epoch. Token
  сохраняется при resume, чтобы потерянный resume reply можно было безопасно
  повторить без создания новой lineage.
- Terminal и unresolved journal metadata загружаются без action replay. Старая
  lineage читает прежний receipt; fresh principal с тем же именем доступа не
  получает. Response payload не сохраняется: повтор возвращает receipt-expired
  со ссылкой на operation, не запускает adapter заново.
- Native permissions control channel проверяет request/runtime/login/native
  generation и loaded build. Health возвращает свежие passive grants с
  SecCode self identity, когда helper её предоставил. При отсутствии подписи
  или mismatch явно возвращается permissionsUnavailable.
- Metadata subprocess cleanup теперь TERM → bounded wait → KILL → подтверждение
  exit; не подтверждённый exit является ошибкой, а не успешным завершением probe.
- Focused restart/reservations/host/persistence: **17 pass / 114 assertions**.
  Полный предыдущий runtime run: 96 pass и один устаревший message assertion,
  после исправления wording соответствующий тест повторно прошёл. Root tsc
  остановился только на незавершённых installer helpers в параллельной работе.
- Остаётся: подтверждённое восстановление старого held-input ledger новым
  helper, bounded retention/session cleanup и live native generation rotation.

Следующий транспортный срез:

- Отдельный adminToken из private credential разрешает только administrative
  inspect/drain routes. Session bearer и bootstrapToken там отклоняются.
  Drain проверяет exact epoch/runtime build и, если передан, native build до
  callback; receipt и повторный inspect должны подтвердить тот же host и нулевые
  active/quarantined ресурсы. Незавершённый startup recovery блокирует drain.
- RuntimeUdsClient предоставляет adminInspect/adminDrain; host связывает их с
  реальным native drain. Method descriptor содержит timeoutMs, и callTool
  использует актуальный budget из каталога вместо фиксированных пяти секунд.
- Native metadata stdout ограничен 1 MiB, stderr одновременно читается с
  пределом 64 KiB; оба потока и subprocess имеют deadline, незавершённый child
  завершается при выходе из probe. Payload stderr не включается в diagnostics.
- Проверка transport/registry/clipboard/host: **18 pass / 131 assertions**;
  root typecheck **exit 0**, diff-check **pass**.

- Core записывает registered и dispatching до вызова adapter. Проверенный
  terminal record с cleanup receipt сохраняется до освобождения resource.
  Recovery старых browser operations использует тот же staged durable порядок.
- Каждая durable write ограничена отдельным deadline. Зависание навсегда
  закрывает admission; queued writes не обходят poisoned storage. Cancel/drain
  завершают ожидание, поздний ACK не меняет receipt и не снимает quarantine.
- Host подключает FileOperationJournal и FileHeldInputLedger из принятого
  storage-модуля. META_RUNTIME_STATE_DIR задаёт private state directory;
  по умолчанию используется state рядом с socket. Незавершённые операции и
  unreleased ledger entries закрывают startup admission и видны в doctor.
- После process crash новый epoch загружает старые записи только как recovery
  evidence: action не воспроизводится, новая lineage не получает старую operation.
  Durable resumption credentials, explicit recovery credential и автоматическая
  reconciliation после restart пока не реализованы.
- Host использует registerWindowMethods с сохранением permission-revocation
  hook. Browser coordinator принимает caller AbortSignal. Resource expiry
  следует operation deadline с верхним пределом 120 секунд, а не обрывает
  33-секундную typing operation прежним пределом 30 секунд.
- Capture publication выдаётся по lineage/clientRequestId, включая concurrent
  retry; commit требует завершённую операцию, frame и выданный native proof.
  Browser proof authority и полный capture lifecycle ещё требуют интеграции.
- Последний полный runtime run: **80 pass / 430 assertions**. Это fake/temp
  filesystem evidence, включая реальный дочерний process crash; live desktop,
  installed services и Native helper не запускались и не переключались.
- Root typecheck в последнем проходе остановился на двух TS2352 в параллельно
  изменяемом browser-methods.ts; владелец уведомлён. До этих изменений typecheck
  host/core проходил. Полная приёмка пока не заявляется.

## Checkpoint MethodRegistry, host и clipboard mapper

Доработка после host review:

- Последние catalogue corrections: seal/unseal вызывают admission notification,
  registry увеличивает revision и фильтрует descriptors тем же
  availableDuringDrain policy, который использует dispatch. Clipboard descriptors
  используют concrete Input-owned read/write request/result schemas; union.refine
  больше не создаёт ложную JSON Schema. Targeted host/registry **6 pass/40
  assertions**, root typecheck **exit 0**, diff-check **pass**.

- Method definition snapshot фиксируется в register: input/output schema clones,
  bound execute/frames/isError callbacks и immutable annotations/budgets.
- Catalogue advertisement и dispatch используют тот же actual host capability
  snapshot; required dependencies проверяются, native transport close/permission
  revocation понижают доступность. Clipboard read/write имеют разные annotations.
- Serialized clipboard profile — explicit 8 MiB на registry, core output, UDS и
  клиенте, logical text limit остаётся 1 000 000 UTF-8 bytes. Host-owned isError
  predicate сохраняет partial/native failure semantics в MCP result.
- Singleton owner acquired до metadata/helper spawn. Core sealAdmission закрывает
  новые операции до wait/cancel/drain, failure оставляет admission sealed.
- Optional shared NativeAuditSession schema добавлена. Production host требует
  verified native metadata UID/auditSessionId, выводит audit:uid:asid и проверяет
  такое же session в долгоживущем handshake. Static install session env удалён.
- Последний run: **58 pass/317 assertions** в runtime suite, включая 11 storage
  tests отдельного владельца; root typecheck **exit 0**, diff-check **pass**.

- `runtime/src/method-registry.ts`: MethodRegistry выводит descriptors из Zod,
  проверяет active session/input/output, ограничивает execution и сообщает
  revision/list changes. Input не содержит callback или resource policy.
- `runtime/src/transport.ts`: UDS `/v1/catalog`, `/v1/tools/:name`, `/v1/frames/:ref`.
  RuntimeUdsClient публикует `listTools`, `callTool(name,args,signal)`,
  `subscribeCatalogChanged`, `readFrame`. Frame scope — server client lineage;
  `callTool` превращает выданные frameRefs в image content только на клиенте.
- `runtime/src/server.ts` — import-safe entrypoint; `host.ts/createRuntimeHost`
  конфигурирует machine/build check, native handshake/evidence binding, UDS и
  начальный каталог health/get/cancel/list_windows/clipboard. Полный action
  catalogue остаётся следующим integration scope.
- Env: `META_RUNTIME_SOCKET`, `META_RUNTIME_CREDENTIAL`, `META_NATIVE_HELPER`,
  `META_NATIVE_BUILD_ID`, `AI_MACOS_EXPECTED_HOSTNAME`.
  Runtime build внедряется через `__META_RUNTIME_BUILD_ID__`; development fallback
  только явный `META_RUNTIME_BUILD_ID`. `--doctor` читает уже работающий UDS host.
- Историческое ограничение этого checkpoint: ledgerSink отклонял persistence.
  Подключение store описано выше; installed action cutover ещё не выполнен.
- `RuntimeClipboardHandler` использует настоящие Input schemas/adapter/backend,
  проверяет registered native receipt, превращает pending в verified complete
  либо unknown quarantine и исключает clipboard extra из generic AdapterResult.
  Plaintext не пишется в OperationRecord/report; metadata bounded, unresolved
  receipt budget блокирует новые действия без silent eviction.
- Tests clipboard success/mismatch/partial/lost — 4 pass/35 assertions;
  registry/UDS catalogue/frame isolation — 2 pass/11 assertions.
- Последний полный runtime run: **48 pass/274 assertions**, включая 7 tests
  storage-owned slice (файлы storage не менялись). Root typecheck — **exit 0**.

Следующий шаг после scoped checkpoint: принятие storage interfaces → durable
pre-dispatch journal/native ledger/startup reconciliation, затем полный adapter
catalogue и host lifecycle. Installed services не переключались.

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
