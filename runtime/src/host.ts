import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { realpath } from "node:fs/promises"
import {
  capabilitySetSchema, freezeAdapterHostContext,
  nativeHandshakeCompatibility, nativeHandshakeRequestSchema, operationRecordSchema, opaqueIdSchema, z,
  nativeAuditSessionSchema, structurallyEqual, parseWireJson,
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
import { startRuntimeHeartbeat } from "./heartbeat.ts"
import { createBrowserHostComposition, type BrowserHostConfig } from "./browser-host.ts"
import { registerBrowserMethods } from "./browser-methods.ts"
import { registerInputMethods } from "./input-methods.ts"
import { registerCaptureMethods } from "./capture-methods.ts"
import { DesktopInputAdapter } from "@meta/input/adapter"
import { RuntimeScreenAdapter } from "@meta/screen/adapter"
import { ProtocolNativeCaptureDriver } from "@meta/screen/native-driver"
import { NativeCaptureClient } from "@meta/native/capture-client"

export type RuntimeHostOptions = {
  socketPath: string
  credentialPath: string
  runtimeBuildId: string
  expectedNativeBuildId: string
  loginSessionId?: string
  expectedHostname: string
  helperPath?: string
  transport?: NativeTransport
  metadata?: unknown
  transportFactory?: () => NativeTransport
  stateDirectory?: string
  browser?: BrowserHostConfig
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
  const journal = new FileOperationJournal(join(stateDirectory, "operations"))
  const heldLedger = new FileHeldInputLedger(join(stateDirectory, "held-input"))
  const metadata = options.metadata ?? (options.helperPath === undefined ? undefined : await readNativeMetadata(options.helperPath))
  const session = metadata === undefined ? undefined : nativeAuditSessionSchema.parse(z.object({ session: nativeAuditSessionSchema }).parse(metadata).session)
  if (options.helperPath !== undefined && (session === undefined || !session.verified)) throw new Error("Verified native audit session metadata обязательна")
  if (session?.verified && (session.uid !== process.getuid?.() || session.effectiveUid !== process.geteuid?.())) throw new Error("Native metadata UID не совпадает с runtime")
  const loginSessionId = session?.verified ? `audit:${session.uid}:${session.auditSessionId}` : options.loginSessionId
  if (loginSessionId === undefined) throw new Error("Native audit login identity unavailable")
  const generation = { runtimeEpoch: `runtime:${crypto.randomUUID()}`, loginSessionId }
  const clientState = new FileClientState(join(stateDirectory, `clients-${sha256(loginSessionId)}.json`))
  const clientIdentity = await clientState.initialize(loginSessionId)
  const adapterInstanceRef = `adapter:${crypto.randomUUID()}`
  let runtime: RuntimeCore | undefined
  let native: NativeBrokerAdapter | undefined
  let handshake: NativeHandshakeResponse | undefined
  let nativeError: string | undefined
  let clipboard: RuntimeClipboardHandler | undefined
  let draining = false
  let heartbeat: ReturnType<typeof startRuntimeHeartbeat> | undefined
  let browserHost: ReturnType<typeof createBrowserHostComposition> | undefined
  const revokeNative = (reason: string) => {
    nativeError = reason
    runtime?.updateCapabilities(composeHostCapabilities("host:runtime", undefined, reason, browserHost?.capabilitySet))
  }
  if (options.transport !== undefined || options.transportFactory !== undefined || options.helperPath !== undefined) {
    const delegate = options.transport ?? options.transportFactory?.() ?? new NativeProcessTransport(options.helperPath!)
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
      })
      handshake = await native.handshake(request, AbortSignal.timeout(5000))
      const mismatch = nativeHandshakeCompatibility(request, handshake)
      if (mismatch !== undefined) throw new Error(mismatch.message)
      if (session !== undefined && (!session.verified || !structurallyEqual(handshake.session, session))) throw new Error("Live helper audit session не совпадает с metadata")
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error)
      await native.close()
      native = undefined
    }
  }
  try {
  runtime = new RuntimeCore({
    generation, runtimeBuildId: options.runtimeBuildId,
    operationJournal: journal,
    secret: Buffer.from(clientIdentity.secretHex, "hex"), hmacKeyGeneration: clientIdentity.keyGeneration,
    clientPersistence: { sessions: clientIdentity.sessions, persist: sessions => clientState.persist(sessions) },
    completionVerifier: { async verify(context, result) {
      if (clipboard === undefined) throw new Error("Clipboard completion verifier не подключён")
      await clipboard.verify(context, result)
    } },
    ...(native === undefined || handshake === undefined ? {} : {
      native, nativeGeneration: handshake.nativeGeneration,
      nativeSourceIdentity: { adapterInstanceRef, backendBuildId: handshake.nativeBuildId, nativeGeneration: handshake.nativeGeneration },
    }),
  })
  await runtime.initializeRecovery()
  const heldEvidence = await heldLedger.loadAll()
  if (heldEvidence.some(evidence => evidence.snapshot.entries.some(entry => entry.state !== "released"))) {
    runtime.quarantineStartup("Durable native held-input ledger требует explicit recovery")
  }
  if (native !== undefined && handshake !== undefined) {
    runtime.evidence.registerSourceExtractor({ adapterInstanceRef, backendBuildId: handshake.nativeBuildId, nativeGeneration: handshake.nativeGeneration }, extractNativeEvidenceReports)
    clipboard = new RuntimeClipboardHandler(runtime, native)
  }
  const core = runtime
  browserHost = createBrowserHostComposition(core, options.browser ?? {})
  core.updateCapabilities(composeHostCapabilities("host:runtime", native === undefined ? undefined : handshake?.capabilities, undefined, browserHost.capabilitySet))
  const catalog = new MethodRegistry(core)
  registerBrowserMethods(catalog, core, browserHost.bindings)
  if (native !== undefined && handshake !== undefined) {
    const adapterHost = freezeAdapterHostContext({ generation, runtimeBuildId: options.runtimeBuildId, capabilities: handshake.capabilities })
    registerInputMethods(catalog, core, new DesktopInputAdapter(adapterHost, core.services, native))
    registerCaptureMethods(catalog, core, new RuntimeScreenAdapter(adapterHost, core.services,
      new ProtocolNativeCaptureDriver(new NativeCaptureClient(native, core.continuations))))
  }
  const doctor = () => ({
    machine: { hostname: hostname(), matchesExpected: hostname() === options.expectedHostname },
    runtime: { buildId: options.runtimeBuildId, ...generation, draining,
      admissionSealed: core.admissionSealed, recoveryOperations: core.recoveryEvidence().length,
      recoveryReasons: [...core.startupRecoveryReasons()] },
    native: native === undefined || handshake === undefined
      ? { state: "unavailable" as const, reason: nativeError ?? "native helper not configured" }
      : nativeError !== undefined ? { state: "unavailable" as const, reason: nativeError }
        : { state: "compatible" as const, buildId: handshake.nativeBuildId, generation: handshake.nativeGeneration },
    capabilities: core.capabilities,
    activeOperations: core.activeOperationCount(), quarantinedResources: core.resources.quarantinedCount(),
  })
  const doctorSchema = z.strictObject({
    machine: z.strictObject({ hostname: z.string(), matchesExpected: z.boolean() }),
    runtime: z.strictObject({ buildId: z.string(), runtimeEpoch: z.string(), loginSessionId: z.string(), draining: z.boolean(),
      admissionSealed: z.boolean(), recoveryOperations: z.number().int().min(0), recoveryReasons: z.array(z.string()) }),
    native: z.union([
      z.strictObject({ state: z.literal("unavailable"), reason: z.string() }),
      z.strictObject({ state: z.literal("compatible"), buildId: z.string(), generation: z.string() }),
    ]),
    capabilities: capabilitySetSchema, activeOperations: z.number().int().min(0), quarantinedResources: z.number().int().min(0),
    permissions: z.strictObject({
      accessibility: z.strictObject({ granted: z.boolean(), helperPath: z.string(), cdhash: z.string() }),
      screenRecording: z.strictObject({ granted: z.boolean(), ownerPath: z.string(), cdhash: z.string() }),
      postEvents: z.strictObject({ granted: z.boolean(), helperPath: z.string(), cdhash: z.string() }),
    }).optional(),
    permissionsUnavailable: z.string().optional(),
  })
  catalog.register("system_health", {
    title: "Состояние runtime", description: "Пассивная проверка машины, загруженных builds и доступности runtime.",
    input: z.strictObject({}), output: doctorSchema, readOnly: true, availableDuringDrain: true,
    requiredCapabilities: ["runtime.health"], async execute(context) {
      if (native === undefined || handshake === undefined) return { ...doctor(), permissionsUnavailable: "Native helper unavailable" }
      try {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(1000)])
        const response = await native.permissions({ kind: "permissions", protocolVersion: "1", requestId: `permissions:${crypto.randomUUID()}`,
          ...generation, nativeGeneration: handshake.nativeGeneration, deadlineAt: new Date(Date.now() + 1000).toISOString(),
        }, { signal, checkpoint() { signal.throwIfAborted() } })
        if (response.codeIdentity === undefined) throw new Error("Native signed self identity unavailable")
        const { helperPath, cdhash } = response.codeIdentity
        if (options.helperPath !== undefined && await realpath(options.helperPath) !== await realpath(helperPath)) throw new Error("Loaded helper path не совпадает с configured artifact")
        return { ...doctor(), permissions: {
          accessibility: { granted: response.accessibility, helperPath, cdhash },
          screenRecording: { granted: response.screenRecording, ownerPath: helperPath, cdhash },
          postEvents: { granted: response.postEvents, helperPath, cdhash },
        } }
      } catch (error) { return { ...doctor(), permissionsUnavailable: error instanceof Error ? error.message : "Native permissions unavailable" } }
    },
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
    registerWindowMethods(catalog, core, {
      host: windows.host, services: windows.services, capabilities: windows.capabilities,
      transition: windows.transition.bind(windows), inspect: windows.inspect.bind(windows),
      async inventory(control) {
        try {
          const inventory = await windows.inventory(control)
          if (inventory.errors.some(error => error.code === "permission-denied") || inventory.applications.some(app => app.axStatus === "denied")) revokeNative("Native inventory permission revoked")
          return inventory
        } catch (error) { revokeNative("Native inventory unavailable"); throw error }
      },
    })
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
  const drain = async (signal?: AbortSignal) => {
    draining = true
    core.sealAdmission()
    await heartbeat?.stop()
    await core.drainOperations()
    if (core.recoveryEvidence().length > 0 || core.startupRecoveryReasons().length > 0) throw new Error("Startup recovery не завершена")
    if (native === undefined || handshake === undefined) return { cleanup: "complete" as const }
    const control = AbortSignal.any([AbortSignal.timeout(1000), ...(signal === undefined ? [] : [signal])])
    const ack = await native.drain({ requestId: `drain:${crypto.randomUUID()}`, ...generation, nativeGeneration: handshake.nativeGeneration,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, { signal: control, checkpoint() { control.throwIfAborted() } })
    if (ack.cleanup !== "complete" || ack.quarantined || ack.activeOperationIds.length > 0) throw new Error("Native drain не подтверждён")
    return ack
  }
  const uds = new RuntimeUdsServer({ socketPath: options.socketPath, credentialPath: options.credentialPath, core, catalog,
    admin: {
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
  return {
    core, catalog, doctor,
    async start() {
      try {
        if (native !== undefined && handshake !== undefined) heartbeat = startRuntimeHeartbeat({ native,
          generation: { ...generation, nativeGeneration: handshake.nativeGeneration },
          onFailure(error) { core.quarantineStartup(`Native heartbeat unavailable: ${error.message}`); revokeNative("Native heartbeat unavailable") },
        })
        await uds.start()
      }
      catch (error) { core.sealAdmission(); await heartbeat?.stop(); await native?.close(); await releaseLock(); throw error }
    },
    drain,
    async close() { core.sealAdmission(); await heartbeat?.stop(); await uds.stop(); await native?.close(); await releaseLock() },
  }
  } catch (error) { await native?.close(); throw error }
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
