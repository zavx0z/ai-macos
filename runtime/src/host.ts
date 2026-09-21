import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { realpath } from "node:fs/promises"
import {
  capabilitySetSchema, freezeAdapterHostContext,
  nativeHandshakeCompatibility, nativeHandshakeRequestSchema, operationRecordSchema, opaqueIdSchema, z,
  nativeAuditSessionSchema, structurallyEqual, parseWireJson,
  desktopInventorySnapshotSchema,
  type NativeHandshakeResponse,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, NativeProcessTransport, type NativeTransport } from "@meta/native/adapter"
import { NativeWindowAdapter } from "@meta/native/window-adapter"
import { extractNativeEvidenceReports } from "@meta/native/evidence-extractor"
import { RuntimeCore } from "./core.ts"
import { MethodRegistry } from "./method-registry.ts"
import { RuntimeClipboardHandler } from "./clipboard-handler.ts"
import { clipboardReadRequestSchema, clipboardWriteRequestSchema, clipboardReadResultSchema, clipboardWriteResultSchema } from "@meta/input/clipboard-adapter"
import { adapterResultSchema } from "@meta/shared/contracts"
import { RuntimeUdsServer, readBoundedResponseText } from "./transport.ts"
import { acquireHostLock } from "./host-lock.ts"
import { reclaimStaleHostArtifacts } from "./host-artifacts.ts"
import { composeHostCapabilities } from "./host-capabilities.ts"
import { FileHeldInputLedger, FileOperationJournal } from "./storage/index.ts"
import { registerWindowMethods } from "./window-methods.ts"
import { FileClientState } from "./client-state.ts"
import { sha256 } from "./primitives.ts"
import { runtimeHeartbeatFailureReason, startRuntimeHeartbeat } from "./heartbeat.ts"
import { createBrowserHostComposition, type BrowserHostConfig } from "./browser-host.ts"
import { registerBrowserMethods } from "./browser-methods.ts"
import { registerInputMethods } from "./input-methods.ts"
import { registerReadinessMethods } from "./readiness-methods.ts"
import { registerCheckInputMethod } from "./check-input.ts"
import { prepareQuarantinedRestart } from "./restart-quarantined.ts"
import { atomicReplace } from "./storage/atomic-file.ts"
import { registerCaptureMethods } from "./capture-methods.ts"
import { DesktopInputAdapter } from "@meta/input/adapter"
import { RuntimeScreenAdapter } from "@meta/screen/adapter"
import { ProtocolNativeCaptureDriver } from "@meta/screen/native-driver"
import { NativeCaptureClient } from "@meta/native/capture-client"
import { NativeApplicationAdapter } from "@meta/native/application-adapter"
import { registerApplicationMethods } from "./application-methods.ts"
import { NativeActorJournal, type NativeActorRecord } from "./native-actor.ts"
import { RuntimeNativePointHitProvider } from "./input-hit-test.ts"
import { startRuntimeRotation } from "./rotation.ts"
import { StartupHeldRecovery } from "./startup-held-recovery.ts"
import { FileLifetimeStore } from "./lifetime-state.ts"
import { createNativeObserverBinding, NativeObserverPreparationError, type NativeObserverBinding } from "./native-observer-binding.ts"
import { AgentTargetRegistry } from "./agent-targets.ts"
import { AgentViewGuard } from "./agent-view-guard.ts"
import { AgentViewBindings } from "./agent-view-bindings.ts"
import { registerAgentMethods } from "./agent-methods.ts"
import { registerAgentActionMethods } from "./agent-action-methods.ts"
import { registerAgentPointerMethods } from "./agent-pointer-methods.ts"
import { registerAgentAxMethods } from "./agent-ax-methods.ts"
import { registerAgentPipelineMethods } from "./agent-pipeline.ts"
import { registerAgentService } from "./agent-service.ts"
import { RuntimeStartupPermissions, notRequiredStartupPermissions, startupPermissionsStateSchema,
  type StartupPermissionsState } from "./startup-permissions.ts"
import { RuntimeLifecycleLog, type RuntimeLifecycleEvent } from "./lifecycle-log.ts"
import { recentOperationsInputSchema, recentOperationsResultSchema } from "./recent-operations.ts"

export type RuntimeHostOptions = {
  socketPath: string
  credentialPath: string
  runtimeBuildId: string
  expectedNativeBuildId: string
  expectedNativeCdhash?: string
  loginSessionId?: string
  expectedHostname: string
  helperPath?: string
  transport?: NativeTransport
  metadata?: unknown
  transportFactory?: () => NativeTransport
  stateDirectory?: string
  browser?: BrowserHostConfig
  managed?: boolean
  exitAfterRotation?: () => void
  startupPermissions?: { mode: "request-missing" | "passive", waitMs?: number, pollMs?: number }
}

export async function createRuntimeHost(options: RuntimeHostOptions) {
  if (hostname() !== options.expectedHostname) throw new Error("Runtime host machine identity mismatch")
  const releaseLock = await acquireHostLock(options.socketPath)
  try {
    await reclaimStaleHostArtifacts(releaseLock.lease, { socketPath: options.socketPath, credentialPath: options.credentialPath })
    return await createLockedHost(options, releaseLock)
  }
  catch (error) { await releaseLock(); throw error }
}

async function createLockedHost(options: RuntimeHostOptions, releaseLock: () => Promise<void>) {
  const stateDirectory = options.stateDirectory ?? join(dirname(options.socketPath), "state")
  const metadata = options.metadata ?? (options.helperPath === undefined ? undefined : await readNativeMetadata(options.helperPath))
  const session = metadata === undefined ? undefined : nativeAuditSessionSchema.parse(z.object({ session: nativeAuditSessionSchema }).parse(metadata).session)
  if (options.helperPath !== undefined && (session === undefined || !session.verified)) throw new Error("Verified native audit session metadata обязательна")
  if (session?.verified && (session.uid !== process.getuid?.() || session.effectiveUid !== process.geteuid?.())) throw new Error("Native metadata UID не совпадает с runtime")
  const loginSessionId = session?.verified ? `audit:${session.uid}:${session.auditSessionId}` : options.loginSessionId
  if (loginSessionId === undefined) throw new Error("Native audit login identity unavailable")
  const generation = { runtimeEpoch: `runtime:${crypto.randomUUID()}`, loginSessionId }
  const auditStateDirectory = join(stateDirectory, `login-${sha256(loginSessionId)}`)
  const journal = new FileOperationJournal(join(auditStateDirectory, "operations"))
  const heldLedger = new FileHeldInputLedger(join(auditStateDirectory, "held-input"))
  const clientState = new FileClientState(join(auditStateDirectory, "clients.json"))
  const actorJournal = new NativeActorJournal(join(auditStateDirectory, "native-actors"), loginSessionId)
  const clientIdentity = await clientState.initialize(loginSessionId)
  const adapterInstanceRef = `adapter:${crypto.randomUUID()}`
  let lifecycle: RuntimeLifecycleLog | undefined
  let runtime: RuntimeCore | undefined
  let native: NativeBrokerAdapter | undefined
  let ownedProcess: NativeProcessTransport | undefined
  let actorRecord: NativeActorRecord | undefined
  let handshake: NativeHandshakeResponse | undefined
  let nativeError: string | undefined
  let clipboard: RuntimeClipboardHandler | undefined
  let draining = false
  let heartbeat: ReturnType<typeof startRuntimeHeartbeat> | undefined
  let rotation: ReturnType<typeof startRuntimeRotation> | undefined
  let activityUnsubscribe: (() => void) | undefined
  let callUnsubscribe: (() => void) | undefined
  let capabilitiesUnsubscribe: (() => void) | undefined
  let unsubscribeClientExpiries: (() => void) | undefined
  let expiryScheduling = false
  let clientSweep: ReturnType<typeof setTimeout> | undefined
  let browserHost: ReturnType<typeof createBrowserHostComposition> | undefined
  let observerBinding: NativeObserverBinding | undefined
  let viewGuard: AgentViewGuard | undefined
  let viewBindings: AgentViewBindings | undefined
  let viewReady = false
  let observerState: "unavailable" | "preparing" | "ready" = "unavailable"
  let observerReason = "Observer не подготовлен"
  let observerPreparation: { attempt: number, maxAttempts: 3, startedAt: string, deadlineAt: string, nextRetryAt?: string } | undefined
  let backendPreparation: Promise<void> | undefined
  let observerCleanupUnknown = false
  const preparationAbort = new AbortController()
  let windowAdapter: NativeWindowAdapter | undefined
  let nativeCapabilities = handshake?.capabilities
  let permissionFlow: RuntimeStartupPermissions | undefined
  let permissionPreparation: Promise<StartupPermissionsState> | undefined
  const permissionMode = options.startupPermissions?.mode ?? (options.helperPath === undefined ? "passive" : "request-missing")
  if (permissionMode === "request-missing" && options.helperPath !== undefined && options.expectedNativeCdhash === undefined) {
    throw new Error("Actual startup permission request требует expected Native cdhash")
  }
  if (options.expectedNativeCdhash !== undefined && !/^[a-f0-9]{40,64}$/i.test(options.expectedNativeCdhash)) throw new Error("Expected Native cdhash invalid")
  let permissionFallback = permissionMode === "passive" ? notRequiredStartupPermissions()
    : startupPermissionsStateSchema.parse({ state: "checking",
        required: ["accessibility", "screenRecording", "postEvents", "inputMonitoring"], missing: [],
        requestIssued: false, requestsFinished: false, restartNeeded: false, restartState: "not-required" })
  let beginBackendPreparation: () => Promise<void> = async () => undefined
  const revokeNative = (reason: string) => {
    nativeError = reason
    void lifecycle?.record("native-revoked", reason).catch(() => undefined)
    runtime?.updateCapabilities(composeHostCapabilities("host:runtime", undefined, reason, browserHost?.capabilitySet))
  }
  if (options.transport !== undefined || options.transportFactory !== undefined || options.helperPath !== undefined) {
    const delegate = options.transport ?? options.transportFactory?.() ?? (ownedProcess = new NativeProcessTransport(options.helperPath!))
    const transport: NativeTransport = {
      send: frame => delegate.send(frame),
      close: () => delegate.close(),
      async *packets(signal) {
        try { yield* delegate.packets(signal) }
        catch (error) { revokeNative("Native transport disconnected"); throw error }
        finally { revokeNative("Native transport closed") }
      },
    }
    native = new NativeBrokerAdapter({
      adapterInstanceRef,
      host: freezeAdapterHostContext({
        generation, runtimeBuildId: options.runtimeBuildId,
        capabilities: { scope: "adapter", schemaVersion: "1", producerRef: adapterInstanceRef, capabilities: [] },
      }),
      transport,
      ledgerSink: heldLedger,
      bindEvidence(identity) {
        const binding = { adapterInstanceRef: identity.adapterInstanceRef, backendBuildId: identity.loadedBuildId, nativeGeneration: identity.generation.nativeGeneration }
        return {
          publisher: { publish: report => {
            if (runtime === undefined) throw new Error("Runtime evidence authority ещё не создана")
            return runtime.evidence.bind(binding).publish(report)
          } },
          sourceResponses: { register(ref, bytes) {
            if (runtime === undefined) throw new Error("Runtime source authority ещё не создана")
            runtime.evidence.registerSourceResponse(binding, ref, bytes)
          } },
        }
      },
    })
    try {
      const request = nativeHandshakeRequestSchema.parse({
        kind: "handshake", protocolVersion: "1", requestId: `handshake:${crypto.randomUUID()}`,
        ...generation, runtimeBuildId: options.runtimeBuildId, expectedNativeBuildId: options.expectedNativeBuildId,
        capabilitySchemaVersion: "1",
        ...(options.helperPath === undefined ? {} : { requiredRecoveryDomainVersion: "1" }),
        ...(options.helperPath === undefined ? {} : { requiredViewAdmissionVersion: "1" }),
      })
      handshake = await native.handshake(request, AbortSignal.timeout(5000))
      const mismatch = nativeHandshakeCompatibility(request, handshake)
      if (mismatch !== undefined) throw new Error(mismatch.message)
      nativeCapabilities = handshake.capabilities
      lifecycle = new RuntimeLifecycleLog({ directory: join(auditStateDirectory, "lifecycle"), ...generation,
        nativeGeneration: handshake.nativeGeneration, nativeBuildId: handshake.nativeBuildId })
      if (session !== undefined && (!session.verified || !structurallyEqual(handshake.session, session))) throw new Error("Live helper audit session не совпадает с metadata")
      if (ownedProcess !== undefined && options.helperPath !== undefined) {
        if (ownedProcess.processStatus.pid !== handshake.process.pid || ownedProcess.processStatus.exitConfirmed) throw new Error("Native handshake не принадлежит живому owned child")
        actorRecord = await actorJournal.register(handshake, options.helperPath)
      }
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error)
      await native.close()
      native = undefined
    }
  }
  const closeNative = async () => {
    await native?.close()
    if (ownedProcess !== undefined && actorRecord !== undefined) {
      if (!ownedProcess.processStatus.exitConfirmed || ownedProcess.processStatus.pid !== actorRecord.process.pid) throw new Error("Owned native process exit не подтверждён")
      await actorJournal.markConfirmedExit(actorRecord)
    }
  }
  try {
  const startupRecovery = new StartupHeldRecovery({ directory: join(auditStateDirectory, "held-recovery"),
    generation, journal, ledgers: heldLedger, actors: actorJournal, ...(native === undefined ? {} : { native }) })
  runtime = new RuntimeCore({
    generation, runtimeBuildId: options.runtimeBuildId,
    operationJournal: journal,
    lifetimeStore: new FileLifetimeStore(join(auditStateDirectory, "lifetimes")),
    startupRecovery,
    secret: Buffer.from(clientIdentity.secretHex, "hex"), hmacKeyGeneration: clientIdentity.keyGeneration,
    clientPersistence: { sessions: clientIdentity.sessions, persist: sessions => clientState.persist(sessions) },
    completionVerifier: { async verify(context, result) {
      if (clipboard === undefined) throw new Error("Clipboard completion verifier не подключён")
      await clipboard.verify(context, result)
    } },
    ...(native === undefined || handshake === undefined ? {} : {
      native, nativeGeneration: handshake.nativeGeneration, nativeDelivery: native.mutationDelivery,
      ...(handshake.recoveryDomainVersion === "1" ? { nativeRecovery: { policyVersion: "1", nativeBuildId: handshake.nativeBuildId } } : {}),
      nativeSourceIdentity: { adapterInstanceRef, backendBuildId: handshake.nativeBuildId, nativeGeneration: handshake.nativeGeneration },
    }),
  })
  await runtime.initializeRecovery()
  if (native !== undefined && handshake !== undefined) {
    if (handshake.recoveryDomainVersion === "1") native.configureRecoveryAuthority((wire, descriptor) => runtime!.authorizeNativeMutation(wire, descriptor))
    runtime.bindPointEvidenceProvider(new RuntimeNativePointHitProvider({ native }).provide)
    runtime.evidence.registerSourceExtractor({ adapterInstanceRef, backendBuildId: handshake.nativeBuildId, nativeGeneration: handshake.nativeGeneration }, extractNativeEvidenceReports)
    clipboard = new RuntimeClipboardHandler(runtime, native)
  }
  const core = runtime
  const agentTargets = new AgentTargetRegistry({ generation })
  if (native !== undefined && handshake?.viewAdmissionVersion === "1" && handshake.recoveryDomainVersion === "1") {
    const authorize = core.bindNativeViewAdmission(async context => {
      if (!viewReady || viewBindings === undefined) throw new Error("Runtime view admission ещё не готов")
      return viewBindings.authorizeNative(context)
    })
    native.configureViewAdmissionAuthorizer(async (wire, operation, control) => {
      control.signal.throwIfAborted()
      return authorize(wire, operation)
    })
  }
  browserHost = createBrowserHostComposition(core, options.browser ?? {})
  await core.browserLifetime.restorePersisted()
  const unsubscribeLineageCleanup = core.subscribeLineageCleanup(lineageId => {
    viewBindings?.releaseLineage(lineageId)
    viewGuard?.releaseLineage(lineageId)
    agentTargets.releaseLineage(lineageId)
  })
  const refreshCapabilities = () => core.updateCapabilities(composeHostCapabilities("host:runtime",
    native === undefined || nativeError !== undefined ? undefined : nativeCapabilities,
    nativeError, browserHost?.capabilitySet, observerState === "ready", viewReady))
  refreshCapabilities()
  const readPassivePermissions = async (signal: AbortSignal) => {
    if (native === undefined || handshake === undefined) throw new Error("Native helper unavailable")
    const response = await native.permissions({ kind: "permissions", protocolVersion: "1", requestId: `permissions:${crypto.randomUUID()}`,
      ...generation, nativeGeneration: handshake.nativeGeneration, deadlineAt: new Date(Date.now() + 1000).toISOString(),
    }, { signal, checkpoint() { signal.throwIfAborted() } })
    nativeCapabilities = response.capabilities
    refreshCapabilities()
    return response
  }
  if (permissionMode === "request-missing") {
    if (native === undefined) {
      permissionFallback = startupPermissionsStateSchema.parse({ ...permissionFallback, state: "failed",
        reason: nativeError ?? "Verified Native helper недоступен для startup permission request" })
    } else {
      permissionFlow = new RuntimeStartupPermissions({
        native,
        ...(options.startupPermissions?.waitMs === undefined ? {} : { waitMs: options.startupPermissions.waitMs }),
        ...(options.startupPermissions?.pollMs === undefined ? {} : { pollMs: options.startupPermissions.pollMs }),
        onCapabilities(capabilities) { nativeCapabilities = capabilities; refreshCapabilities() },
        onReady() { void beginBackendPreparation() },
        onBlocked() {
          core.sealAdmission()
          viewReady = false
          void viewGuard?.close()
          refreshCapabilities()
        },
        async verifyOwner(signal) {
          const response = await readPassivePermissions(signal)
          if (response.codeIdentity === undefined) throw new Error("Native signed self identity unavailable до permission request")
          const { helperPath, cdhash } = response.codeIdentity
          if (options.helperPath !== undefined && await realpath(options.helperPath) !== await realpath(helperPath)) throw new Error("Permission owner path не совпадает с configured helper")
          if (options.expectedNativeCdhash !== undefined && cdhash.toLowerCase() !== options.expectedNativeCdhash.toLowerCase()) throw new Error("Permission owner cdhash не совпадает с release manifest")
        },
      })
    }
  }
  const catalog = new MethodRegistry(core)
  const agentMethods = registerAgentMethods(catalog, core, agentTargets, { views: {
    observe: async (session, targetId, target, capture, complete) => {
      // Новый explicit observe может восстановить только observer. Действия
      // не повторяются, старые tickets не переносятся между bindings.
      if (!viewReady || viewGuard?.available === false) await beginBackendPreparation()
      return viewBindings === undefined ? capture() : viewBindings.observe(session, targetId, target, capture, complete)
    },
    run: (session, targetId, requestId, mode, action) => {
      if (!viewReady || viewBindings === undefined) throw new Error("Protected action требует готовый Native view admission")
      return viewBindings.run(session, targetId, requestId, mode, action)
    },
  } })
  registerAgentActionMethods(catalog, agentMethods)
  registerAgentPipelineMethods(catalog, core, agentTargets)
  if (native !== undefined && handshake?.viewAdmissionVersion === "1" && handshake.recoveryDomainVersion === "1") {
    const pointer = registerAgentPointerMethods(catalog, agentMethods)
    registerAgentAxMethods(catalog, core, agentTargets, agentMethods, agentMethods.operations, pointer)
  }
  const recoverStartup = async (operationId?: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const result = await startupRecovery.recover(operationId, signal)
    signal?.throwIfAborted()
    await core.refreshStartupRecovery(!draining)
    return { ...result, remainingOperations: core.recoveryEvidence().length, admissionSealed: core.admissionSealed }
  }
  catalog.register("recover_startup_input", {
    title: "Восстановить завершённый input actor",
    description: "Пассивно проверяет точный старый held-input ledger своей lineage. События ввода не отправляются; без actor exit и ALL-UP quarantine сохраняется.",
    input: z.strictObject({ operationId: opaqueIdSchema }),
    output: z.strictObject({ resolved: z.number().int().min(0), unresolved: z.number().int().min(0), remainingOperations: z.number().int().min(0), admissionSealed: z.boolean() }),
    readOnly: false, destructive: false, availableDuringDrain: true, timeoutMs: 10_000, requiredCapabilities: ["runtime.operations"],
    async execute(context, input) {
      if (await core.getOperation(context.session, input.operationId) === undefined) throw new Error("Operation недоступна этой lineage")
      return recoverStartup(input.operationId, context.signal)
    },
    isError: output => output.unresolved > 0 || output.remainingOperations > 0,
  })
  registerBrowserMethods(catalog, core, browserHost.bindings)
  if (native !== undefined && handshake !== undefined) {
    if (handshake.capabilities.capabilities.some(capability => capability.id === "desktop.application.lifecycle" && capability.state === "ready")) {
      registerApplicationMethods(catalog, core, new NativeApplicationAdapter({ native, services: core.services }))
    }
    const adapterHost = freezeAdapterHostContext({ generation, runtimeBuildId: options.runtimeBuildId, capabilities: handshake.capabilities })
    registerInputMethods(catalog, core, new DesktopInputAdapter(adapterHost, core.services, native), { visibility: "internal" })
    if (handshake.capabilities.capabilities.some(capability => capability.id === "input.readiness" && capability.state === "ready")) {
      registerReadinessMethods(catalog, core, native, { visibility: "internal" })
    }
    registerCaptureMethods(catalog, core, new RuntimeScreenAdapter(adapterHost, core.services,
      new ProtocolNativeCaptureDriver(new NativeCaptureClient(native, core.continuations))))
  }
  const doctor = () => ({
    startup: { permissions: permissionFlow?.snapshot() ?? permissionFallback },
    machine: { hostname: hostname(), matchesExpected: hostname() === options.expectedHostname },
    runtime: { buildId: options.runtimeBuildId, ...generation, draining,
      admissionSealed: core.admissionSealed, recoveryOperations: core.recoveryEvidence().length,
      recoveryReasons: [...core.startupRecoveryReasons()], clients: core.clientLifecycleStatus(),
      rotation: rotation?.status() ?? { state: "running" as const } },
    observer: { state: observerState, reason: observerReason, viewReady,
      ...(observerPreparation === undefined ? {} : { preparation: observerPreparation }) },
    native: native === undefined || handshake === undefined
      ? { state: "unavailable" as const, reason: nativeError ?? "native helper not configured" }
      : nativeError !== undefined ? { state: "unavailable" as const, reason: nativeError }
        : { state: "compatible" as const, buildId: handshake.nativeBuildId, generation: handshake.nativeGeneration },
    capabilities: core.capabilities,
    activeOperations: core.activeOperationCount(), quarantinedResources: core.resources.quarantinedCount(),
  })
  const doctorSchema = z.strictObject({
    startup: z.strictObject({ permissions: startupPermissionsStateSchema }),
    observer: z.strictObject({ state: z.enum(["unavailable", "preparing", "ready"]), reason: z.string(), viewReady: z.boolean(),
      preparation: z.strictObject({ attempt: z.number().int().min(1).max(3), maxAttempts: z.literal(3),
        startedAt: z.iso.datetime({ offset: true }), deadlineAt: z.iso.datetime({ offset: true }),
        nextRetryAt: z.iso.datetime({ offset: true }).optional() }).optional() }),
    machine: z.strictObject({ hostname: z.string(), matchesExpected: z.boolean() }),
    runtime: z.strictObject({ buildId: z.string(), runtimeEpoch: z.string(), loginSessionId: z.string(), draining: z.boolean(),
      admissionSealed: z.boolean(), recoveryOperations: z.number().int().min(0), recoveryReasons: z.array(z.string()),
      clients: z.strictObject({ pendingGrace: z.number().int().min(0), cleanupFailures: z.number().int().min(0) }),
      rotation: z.strictObject({ state: z.enum(["running", "restart-needed", "draining", "blocked", "restarting"]), reason: z.string().optional(), recovery: z.literal("restart-safe-quarantined").optional() }) }),
    native: z.union([
      z.strictObject({ state: z.literal("unavailable"), reason: z.string() }),
      z.strictObject({ state: z.literal("compatible"), buildId: z.string(), generation: z.string() }),
    ]),
    capabilities: capabilitySetSchema, activeOperations: z.number().int().min(0), quarantinedResources: z.number().int().min(0),
    permissions: z.strictObject({
      accessibility: z.strictObject({ granted: z.boolean(), helperPath: z.string(), cdhash: z.string() }),
      screenRecording: z.strictObject({ granted: z.boolean(), ownerPath: z.string(), cdhash: z.string() }),
      postEvents: z.strictObject({ granted: z.boolean(), helperPath: z.string(), cdhash: z.string() }),
      inputMonitoring: z.strictObject({ granted: z.boolean(), helperPath: z.string(), cdhash: z.string() }),
    }).optional(),
    permissionsUnavailable: z.string().optional(),
  })
  catalog.register("system_health", {
    title: "Состояние runtime", description: "Проверка машины, загруженных builds и доступности runtime; при недоступном observer запускает bounded восстановление подписок без ввода и restart.",
    input: z.strictObject({}), output: doctorSchema, readOnly: true, availableDuringDrain: true,
    requiredCapabilities: ["runtime.health"], async execute(context) {
      if (observerState !== "ready"
        && handshake?.viewAdmissionVersion === "1"
        && handshake.recoveryDomainVersion === "1") {
        const recovery = beginBackendPreparation()
        try {
          await settleBeforeAbort(recovery, AbortSignal.any([context.signal, AbortSignal.timeout(3_000)]), "Observer recovery during system_health")
        } catch {
          // Preparation продолжает жить в backendPreparation; health возвращает фактический ready/preparing/unavailable.
        }
      }
      if (native === undefined || handshake === undefined) return { ...doctor(), permissionsUnavailable: "Native helper unavailable" }
      try {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(1000)])
        if (permissionFlow !== undefined && permissionFlow.snapshot().state !== "ready") await permissionFlow.refreshStatus(signal)
        const response = await readPassivePermissions(signal)
        if (response.codeIdentity === undefined) throw new Error("Native signed self identity unavailable")
        const { helperPath, cdhash } = response.codeIdentity
        if (options.helperPath !== undefined && await realpath(options.helperPath) !== await realpath(helperPath)) throw new Error("Loaded helper path не совпадает с configured artifact")
        return { ...doctor(), permissions: {
          accessibility: { granted: response.accessibility, helperPath, cdhash },
          screenRecording: { granted: response.screenRecording, ownerPath: helperPath, cdhash },
          postEvents: { granted: response.postEvents, helperPath, cdhash },
          inputMonitoring: { granted: response.inputMonitoring, helperPath, cdhash },
        } }
      } catch (error) { return { ...doctor(), permissionsUnavailable: error instanceof Error ? error.message : "Native permissions unavailable" } }
    },
  })
  catalog.register("list_recent_operations", {
    title: "Недавние операции",
    description: "Возвращает bounded receipts текущей подтверждённой lineage, включая восстановленные после restart. Payload и вводимый текст не возвращаются; действия не повторяются.",
    input: recentOperationsInputSchema, output: recentOperationsResultSchema,
    readOnly: true, availableDuringDrain: true, requiredCapabilities: ["runtime.operations"], maxResponseBytes: 64 * 1024,
    execute: (context, input) => core.listRecentOperations(context.session, input.limit),
  })
  catalog.register("get_operation", {
    title: "Состояние операции", description: "Чтение operation receipt текущей client lineage без повтора действия.",
    input: z.strictObject({ operationId: opaqueIdSchema }), output: z.strictObject({ operation: operationRecordSchema.nullable() }), readOnly: true,
    availableDuringDrain: true, requiredCapabilities: ["runtime.operations"],
    async execute(context, input) { return { operation: await core.getOperation(context.session, input.operationId) ?? null } },
  })
  catalog.register("cancel_operation", {
    title: "Отмена операции", description: "Запрос остановки операции и чтение подтверждённого cleanup outcome.",
    input: z.strictObject({ operationId: opaqueIdSchema, reason: z.string().min(1).max(1024) }),
    output: z.strictObject({ operation: operationRecordSchema }), readOnly: false, destructive: true,
    availableDuringDrain: true, requiredCapabilities: ["runtime.operations"],
    async execute(context, input) { return { operation: await core.cancelOperation(context.session, input.operationId, input.reason) } },
  })
  if (native !== undefined) {
    const windows = new NativeWindowAdapter({ native, services: core.services })
    windowAdapter = windows
    const { applications: _applicationShape, windows: _windowShape, ...displayShape } = desktopInventorySnapshotSchema.shape
    catalog.register("list_displays", {
      title: "Дисплеи и topology",
      description: "Возвращает exact display refs и inventory для специализированного desktop capture; ввод не выполняется.",
      input: z.strictObject({}), output: z.strictObject(displayShape),
      readOnly: true, timeoutMs: 6000, requiredCapabilities: ["desktop.displays"],
      async execute(context) {
        const snapshot = desktopInventorySnapshotSchema.parse(await windows.inventory({ signal: context.signal, checkpoint() { context.signal.throwIfAborted() } }))
        const { applications: _applications, windows: _windows, ...displaySnapshot } = snapshot
        return displaySnapshot
      },
    })
    if (handshake?.capabilities.capabilities.some(capability => capability.id === "input.readiness" && capability.state === "ready")) {
      registerCheckInputMethod(catalog, { native, windows })
    }
    registerWindowMethods(catalog, core, {
      host: windows.host, services: windows.services, capabilities: windows.capabilities,
      transition: windows.transition.bind(windows), inspect: windows.inspect.bind(windows),
      press: windows.press.bind(windows),
      async inventory(control, priority) {
        const inventory = await windows.inventory(control, priority)
        const permissionSuspected = inventory.errors.some(error => error.code === "permission-denied")
          || inventory.applications.some(app => app.axStatus === "denied")
        if (permissionSuspected) {
          try {
            const signal = AbortSignal.any([control.signal, AbortSignal.timeout(1000)])
            const permissions = await readPassivePermissions(signal)
            if (!permissions.accessibility) revokeNative("Native Accessibility permission revoked")
          } catch {
            control.signal.throwIfAborted()
            // Ошибка локальной inventory или passive recheck не доказывает
            // недоступность transport либо глобальный отзыв Accessibility.
          }
        }
        return inventory
      },
    }, { internalAgentMethods: true })
  }
  if (clipboard !== undefined && handshake?.capabilities.capabilities.some(capability => capability.id === "input.clipboard" && capability.state === "ready")) {
    const handler = clipboard
    for (const kind of ["read", "write"] as const) {
      const inputSchema = z.strictObject({ clientRequestId: opaqueIdSchema,
        request: kind === "read" ? clipboardReadRequestSchema : clipboardWriteRequestSchema })
      const outputSchema = z.strictObject({ operation: operationRecordSchema,
        result: adapterResultSchema(kind === "read" ? clipboardReadResultSchema : clipboardWriteResultSchema) })
      catalog.register(`clipboard_${kind}`, {
        title: "Системный clipboard", description: "Явное чтение или запись clipboard с проверкой optimistic expectedVersion.",
        input: inputSchema, output: outputSchema,
        readOnly: kind === "read", destructive: kind === "write", timeoutMs: 7000,
        requiredCapabilities: ["input.clipboard"], maxRequestBytes: 8 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024,
        isError: output => !output.result.ok,
        async execute(context, input) { return outputSchema.parse(await handler.execute(context.session, input.clientRequestId, input.request, context.signal)) },
      })
    }
  }
  // Общий порядок для drain и recovery restart. Не переносить итоговую
  // проверку quarantine перед domain-owned cleanup: она сделает cleanup недостижимой.
  const stopOperationsAndBrowserLifetimes = async (signal?: AbortSignal) => {
    let phase = "operations-stop"
    try {
      signal?.throwIfAborted()
      await core.stopOperations()
      signal?.throwIfAborted()
      phase = "client-grace"
      await core.drainClientGrace()
      signal?.throwIfAborted()
      phase = "browser-lifetime-cleanup"
      await core.browserLifetime.shutdownLineage(undefined, signal)
      signal?.throwIfAborted()
    } catch (error) {
      // Только фиксированная фаза и счётчики: сообщение adapter может содержать URL или payload.
      await lifecycle?.record("drain-failed", `cleanup:${phase};active=${core.activeOperationCount()};quarantined=${core.resources.quarantinedCount()}`).catch(() => undefined)
      throw error
    }
  }
  const performDrain = async (signal?: AbortSignal) => {
    draining = true
    await lifecycle?.record("drain-start").catch(() => undefined)
    core.sealAdmission()
    preparationAbort.abort("Runtime drain отменил preparation")
    expiryScheduling = false
    unsubscribeClientExpiries?.()
    if (clientSweep !== undefined) clearTimeout(clientSweep)
    await heartbeat?.stop()
    await stopOperationsAndBrowserLifetimes(signal)
    core.assertOperationsDrained()
    await permissionPreparation?.catch(() => undefined)
    await backendPreparation
    await viewGuard?.close()
    viewReady = false
    await observerBinding?.close()
    if (core.recoveryEvidence().length > 0 || core.startupRecoveryReasons().length > 0) throw new Error("Startup recovery не завершена")
    if (native === undefined || handshake === undefined) { await lifecycle?.record("drain-complete").catch(() => undefined); return { cleanup: "complete" as const } }
    const control = AbortSignal.any([AbortSignal.timeout(1000), ...(signal === undefined ? [] : [signal])])
    const ack = await native.drain({ requestId: `drain:${crypto.randomUUID()}`, ...generation, nativeGeneration: handshake.nativeGeneration,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, { signal: control, checkpoint() { control.throwIfAborted() } })
    if (ack.cleanup !== "complete" || ack.quarantined || ack.activeOperationIds.length > 0) throw new Error("Native drain не подтверждён")
    await lifecycle?.record("drain-complete").catch(() => undefined)
    return ack
  }
  let drainingPromise: ReturnType<typeof performDrain> | undefined
  const drain = (signal?: AbortSignal) => {
    drainingPromise ??= performDrain(signal).catch(error => {
      void lifecycle?.record("drain-failed", `drain:${error instanceof Error ? error.name : "unknown"}`).catch(() => undefined)
      drainingPromise = undefined
      throw error
    })
    return drainingPromise
  }
  registerAgentService(catalog, core, { expectedHostname: options.expectedHostname })
  const uds = new RuntimeUdsServer({ socketPath: options.socketPath, credentialPath: options.credentialPath, core, catalog,
    admin: {
      recover: (expected, signal) => recoverStartup(expected.operationId, signal),
      inspect: () => ({ running: true, runtimeEpoch: generation.runtimeEpoch, runtimeBuildId: options.runtimeBuildId,
        ...(handshake === undefined ? {} : { nativeBuildId: handshake.nativeBuildId }),
        activeOperations: core.activeOperationCount(), quarantinedResources: core.resources.quarantinedCount() }),
      async drain(_expected, signal) {
        if (handshake === undefined) throw new Error("Native build для admin drain неизвестен")
        await drain(signal)
        return { runtimeEpoch: generation.runtimeEpoch, runtimeBuildId: options.runtimeBuildId, nativeBuildId: handshake.nativeBuildId,
          cleanup: "complete", activeOperations: 0, quarantinedResources: 0 }
      },
    },
  })
  let closing: Promise<void> | undefined
  const prepareRecoveryRestart = async (signal?: AbortSignal) => {
    if (ownedProcess === undefined || actorRecord === undefined || handshake?.recoveryDomainVersion !== "1") throw new Error("Recovery restart требует owned v1 Native actor")
    return prepareQuarantinedRestart({ signal,
      seal() { core.sealAdmission(); preparationAbort.abort("Recovery restart") },
      async retain(control) {
        await stopOperationsAndBrowserLifetimes(control)
        const retained = await core.retainForRecoveryRestart()
        control.throwIfAborted()
        return retained
      },
      async stopOwnedNative() {
        await heartbeat?.stop()
        await backendPreparation
        await observerBinding?.hub.close()
        await closeNative()
        observerBinding = undefined
        return ownedProcess!.processStatus
      },
      async persistExit(receipt) {
        await atomicReplace(join(auditStateDirectory, `restart-${generation.runtimeEpoch.replaceAll(":", "-")}.json`),
          new TextEncoder().encode(JSON.stringify({ ...generation, nativeGeneration: handshake!.nativeGeneration,
            nativeBuildId: handshake!.nativeBuildId, recordedAt: new Date().toISOString(), ...receipt })))
      },
    })
  }
  beginBackendPreparation = () => {
    if (backendPreparation !== undefined) return backendPreparation
    if (native === undefined || nativeError !== undefined || observerCleanupUnknown || draining || preparationAbort.signal.aborted
      || core.activeOperationCount() !== 0) return Promise.resolve()
    if (observerState === "ready" && (viewGuard === undefined || viewGuard.available)) return Promise.resolve()
    const source = native
    observerState = "preparing"
    observerReason = "Подготовка свежего Native AX index"
    const preparationStartedAt = new Date()
    const preparationDeadlineAt = new Date(preparationStartedAt.getTime() + 26_000)
    observerPreparation = { attempt: 1, maxAttempts: 3, startedAt: preparationStartedAt.toISOString(), deadlineAt: preparationDeadlineAt.toISOString() }
    refreshCapabilities()
    const preparationSignal = AbortSignal.any([preparationAbort.signal, AbortSignal.timeout(26_000)])
    backendPreparation = (async () => {
      try {
        preparationSignal.throwIfAborted()
        viewReady = false
        viewBindings = undefined
        await viewGuard?.close()
        viewGuard = undefined
        // Новый prepare допустим только после подтверждённого stop прежнего.
        await observerBinding?.close()
        observerBinding = undefined
        preparationSignal.throwIfAborted()
        observerBinding = await createNativeObserverBinding({ native: source, signal: preparationSignal, onGap(error) {
          observerState = "unavailable"
          viewReady = false
          viewBindings = undefined
          void viewGuard?.close().catch(() => undefined)
          observerReason = error.message
          refreshCapabilities()
        }, async beforeAttempt(_attempt, signal) {
          const permissionSignal = AbortSignal.any([signal, AbortSignal.timeout(1500)])
          const response = await readPassivePermissions(permissionSignal)
          if (!response.accessibility || !response.screenRecording || !response.postEvents || !response.inputMonitoring) {
            throw new Error("Observer prepare запрещён: passive TCC grants больше не подтверждены")
          }
          if (source.generation?.runtimeEpoch !== generation.runtimeEpoch || source.generation.loginSessionId !== generation.loginSessionId
            || source.generation.nativeGeneration !== handshake?.nativeGeneration) throw new Error("Observer prepare Native generation изменилась")
        }, onRetry(attempt, error) {
          observerPreparation = { attempt, maxAttempts: 3, startedAt: preparationStartedAt.toISOString(), deadlineAt: preparationDeadlineAt.toISOString(),
            nextRetryAt: new Date(Date.now() + 1000).toISOString() }
          void lifecycle?.record("observer-failed", `transient attempt ${attempt}: ${error.message}`).catch(() => undefined)
        }, onAttempt(attempt) {
          observerPreparation = { attempt, maxAttempts: 3, startedAt: preparationStartedAt.toISOString(), deadlineAt: preparationDeadlineAt.toISOString() }
        } })
        preparationSignal.throwIfAborted()
        const coverage = await observerBinding.coverage(preparationSignal)
        preparationSignal.throwIfAborted()
        if (coverage.state !== "ready" || coverage.gapDetected || coverage.droppedEvents !== 0) {
          throw new Error(coverage.reason ?? "Native observer coverage недоступна после prepare")
        }
        const preparedObserverState = "ready" as const
        const preparedObserverReason = coverage.reason ?? "Native PUSH coverage подтверждено; session/SecureInput проверяются отдельно"
        if (preparedObserverState === "ready" && handshake?.viewAdmissionVersion === "1" && handshake.recoveryDomainVersion === "1") {
          viewGuard = new AgentViewGuard({ generation: { ...generation, nativeGeneration: handshake.nativeGeneration }, observer: observerBinding.hub,
            resolveTarget: (lineage, targetId) => agentTargets.forLineage(lineage).resolveAction(targetId) })
          await settleBeforeAbort(viewGuard.start(), preparationSignal, "Agent view guard preparation")
          preparationSignal.throwIfAborted()
          observerState = preparedObserverState
          observerReason = preparedObserverReason
          viewBindings = new AgentViewBindings(core, viewGuard)
          viewReady = true
          if (permissionMode === "request-missing") {
            preparationSignal.throwIfAborted()
            try { core.unsealAdmission() }
            catch { /* Startup recovery сохраняет admission sealed независимо от observer/view readiness. */ }
          }
          await lifecycle?.record("observer-ready").catch(() => undefined)
        } else {
          preparationSignal.throwIfAborted()
          observerState = preparedObserverState
          observerReason = preparedObserverReason
        }
      } catch (error) {
        if (error instanceof NativeObserverPreparationError && !error.cleanupConfirmed) observerCleanupUnknown = true
        viewReady = false
        viewBindings = undefined
        await viewGuard?.close().catch(() => undefined)
        viewGuard = undefined
        let cleanupError: unknown
        try { await observerBinding?.close(); observerBinding = undefined }
        catch (cause) { cleanupError = cause }
        observerState = "unavailable"
        observerReason = error instanceof Error ? error.message : "Observer preparation failed"
        if (cleanupError !== undefined) observerReason += `; observer stop: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        // Observer failure закрывает зависимые capabilities, но не чтение
        // и не исправные browser/clipboard пути. Recovery/drain остаются строги.
        if (!draining && !preparationAbort.signal.aborted && nativeError === undefined
          && (permissionFlow === undefined || permissionFlow.snapshot().state === "ready")) {
          try { core.unsealAdmission() }
          catch { /* Неподтверждённые операции/resources запрещают открытие. */ }
        }
        await lifecycle?.record("observer-failed", observerReason).catch(() => undefined)
      } finally {
        observerPreparation = undefined
      }
      refreshCapabilities()
    })().finally(() => { backendPreparation = undefined })
    return backendPreparation
  }
  const close = () => {
    closing ??= (async () => {
      await lifecycle?.record("close-start").catch(() => undefined)
      rotation?.stop()
      activityUnsubscribe?.()
      callUnsubscribe?.()
      capabilitiesUnsubscribe?.()
      core.sealAdmission()
      preparationAbort.abort("Runtime close отменил preparation")
      expiryScheduling = false
      unsubscribeClientExpiries?.()
      if (clientSweep !== undefined) clearTimeout(clientSweep)
      const errors: Error[] = []
      const attempt = async (stage: string, cleanup: () => Promise<unknown> | undefined) => {
        try { await cleanup() }
        catch (cause) { errors.push(new Error(`Runtime close: ${stage} не подтверждён`, { cause })) }
      }
      await attempt("client lifecycle", () => core.closeClientLifecycle())
      unsubscribeLineageCleanup()
      await permissionPreparation?.catch(() => undefined)
      await attempt("backend preparation", () => backendPreparation)
      await attempt("view guard", () => viewGuard?.close())
      viewReady = false
      await attempt("observer stop", () => observerBinding?.close())
      await attempt("heartbeat", () => heartbeat?.stop())
      await attempt("UDS", () => uds.stop())
      await attempt("owned Native exit", closeNative)
      if (ownedProcess === undefined || ownedProcess.processStatus.exitConfirmed) {
        await attempt("host lock", releaseLock)
      } else {
        errors.push(new Error("Host lock сохранён: owned Native exit не подтверждён"))
      }
      if (errors.length > 0) {
        await lifecycle?.record("close-failed", errors.map(error => error.message).join("; ").slice(0, 1024)).catch(() => undefined)
        throw new AggregateError(errors, "Runtime close завершил доступные cleanup steps; часть подтверждений отсутствует")
      }
      await lifecycle?.record("close-complete").catch(() => undefined)
    })()
    return closing
  }
  return {
    core, catalog, doctor, recoverStartup, prepareRecoveryRestart,
    async ready() { await permissionPreparation; await beginBackendPreparation() },
    noteLifecycle(event: RuntimeLifecycleEvent, reason?: string) { return lifecycle?.record(event, reason).catch(() => undefined) ?? Promise.resolve() },
    async start() {
      try {
        await lifecycle?.record("host-start").catch(() => undefined)
        if (permissionFlow !== undefined) core.sealAdmission()
        if (native !== undefined && handshake !== undefined) heartbeat = startRuntimeHeartbeat({ native, active: false,
          generation: { ...generation, nativeGeneration: handshake.nativeGeneration },
          onFailure(error) {
            const reason = runtimeHeartbeatFailureReason(error)
            core.quarantineStartup(reason)
            revokeNative(reason)
          },
        })
        activityUnsubscribe = core.subscribeActivity(() => {
          heartbeat?.setActive(core.activeNativeOperationCount() > 0)
          queueMicrotask(() => rotation?.check())
        })
        callUnsubscribe = catalog.subscribeCallSettled(() => rotation?.check())
        capabilitiesUnsubscribe = core.subscribeCapabilities(() => { queueMicrotask(() => rotation?.check()) })
        await uds.start()
        if (permissionFlow === undefined) void beginBackendPreparation()
        else permissionPreparation = permissionFlow.start(preparationAbort.signal)
        expiryScheduling = true
        const scheduleExpiry = () => {
          if (clientSweep !== undefined) clearTimeout(clientSweep)
          clientSweep = undefined
          if (!expiryScheduling) return
          const next = core.clients.nextExpiryAt()
          if (next === undefined) return
          clientSweep = setTimeout(() => {
            clientSweep = undefined
            core.sweepClientExpiries()
            scheduleExpiry()
          }, Math.max(0, next - Date.now()))
          clientSweep.unref?.()
        }
        unsubscribeClientExpiries = core.clients.subscribeChanged(scheduleExpiry)
        scheduleExpiry()
        rotation = startRuntimeRotation({
          managed: options.managed === true,
          reason() {
            const reason = nativeError !== undefined && actorRecord !== undefined ? "Owned Native actor недоступен; требуется recovery restart"
              : actorRecord !== undefined && core.activeOperationCount() === 0 && core.resources.quarantinedCount() > 0 ? "Current operations quarantined; требуется новый recovery actor"
                : native !== undefined && native.sessionState.requestsUsed >= 8500 ? "Native request budget требует нового процесса"
                  : core.frames.stats().issuedRefs >= 9000 ? "Frame reference budget требует нового процесса" : undefined
            if (reason !== undefined) void lifecycle?.record("rotation-trigger", reason).catch(() => undefined)
            return reason
          },
          seal: () => core.sealAdmission(),
          async drain(signal) { await drain(signal) },
          prepareRecoveryRestart,
          close,
          exit: options.exitAfterRotation ?? (() => process.exit(0)),
        })
      }
      catch (error) {
        expiryScheduling = false
        unsubscribeClientExpiries?.()
        if (clientSweep !== undefined) clearTimeout(clientSweep)
        activityUnsubscribe?.()
        callUnsubscribe?.()
        capabilitiesUnsubscribe?.()
        core.sealAdmission()
        await heartbeat?.stop()
        await closeNative()
        await releaseLock()
        throw error
      }
    },
    drain,
    close,
  }
  } catch (error) { await closeNative(); throw error }
}

async function settleBeforeAbort<T>(work: Promise<T>, signal: AbortSignal, stage: string): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error(`${stage} отменён`))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
  }
}

async function readNativeMetadata(helperPath: string): Promise<unknown> {
  const child = Bun.spawn([helperPath, "--metadata"], { stdout: "pipe", stderr: "pipe" })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all([
        readBoundedResponseText(new Response(child.stdout), 1024 * 1024, 5000), child.exited,
        readBoundedResponseText(new Response(child.stderr), 64 * 1024, 5000),
      ]).then(([text, code]) => {
        if (code !== 0) throw new Error("Native metadata process failed")
        return parseWireJson(z.json(), text)
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("Native metadata deadline")) }, 5000) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      if (!await waitForMetadataExit(child.exited, 100)) {
        child.kill("SIGKILL")
        if (!await waitForMetadataExit(child.exited, 1000)) throw new Error("Native metadata child cleanup не подтверждён после SIGKILL")
      }
    }
  }
}

async function waitForMetadataExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
