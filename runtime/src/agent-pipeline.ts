import {
  browserInstanceRefSchema, browserInstanceSnapshotSchema, browserTargetSnapshotSchema,
  browserOperationResources, operationRecordSchema, structurallyEqual, z,
  type BrowserOperationRequest, type BrowserTargetRef, type RuntimeClientSession,
} from "@meta/shared/contracts"
import { planShortcuts } from "@meta/input/action-plan"
import { agentObservedStateSchema } from "./agent-methods.ts"
import type { AgentTargetRegistry } from "./agent-targets.ts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry, RuntimeMethodContext, RuntimeMethodResponse } from "./method-registry.ts"
import { bindDeadline, operationDeadline, signalDeadline } from "./deadline.ts"
import { canonicalJson, sha256 } from "./primitives.ts"
import { RuntimeContractError } from "./errors.ts"
import { matchPipelineCondition, pipelineConditionSchema, type PipelineCondition } from "./pipeline-conditions.ts"

const id = z.string().min(1).max(127)
const stepId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const uiStep = { id: stepId, when: pipelineConditionSchema }
const stepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...uiStep, kind: z.literal("wait") }),
  z.strictObject({ ...uiStep, kind: z.literal("press") }),
  z.strictObject({ ...uiStep, kind: z.literal("keys"), sequence: z.array(z.string().min(1).max(256)).min(1).max(64) }),
  z.strictObject({ id: stepId, kind: z.literal("chrome-connect"), instance: browserInstanceRefSchema }),
  z.strictObject({ ...uiStep, kind: z.literal("chrome-consent") }),
  z.strictObject({ id: stepId, kind: z.literal("chrome-wait") }),
  z.strictObject({ id: stepId, kind: z.literal("chrome-read"), url: z.string().min(1).max(4096),
    mode: z.enum(["dom", "accessibility"]).default("dom") }),
  z.strictObject({ id: stepId, kind: z.literal("chrome-disconnect") }),
])
export const pipelineInputSchema = z.strictObject({
  clientRequestId: id, runtimeEpoch: id, targetId: id,
  expectedBundleId: z.string().min(1).max(255),
  steps: z.array(stepSchema).min(1).max(16),
  final: z.strictObject({ condition: pipelineConditionSchema.optional(),
    chromeDisconnected: z.literal(true).optional(), caption: z.string().min(1).max(512) }),
}).superRefine((input, context) => {
  const names = new Set<string>()
  let chrome: "none" | "pending" | "consented" | "connected" | "closed" = "none"
  for (const step of input.steps) {
    if (names.has(step.id)) context.addIssue({ code: "custom", message: "Duplicate step id" })
    names.add(step.id)
    if (step.kind === "keys") {
      try { planShortcuts({ shortcuts: step.sequence, delayMs: 0 }) }
      catch { context.addIssue({ code: "custom", message: "Invalid keyboard sequence" }) }
    }
    if (step.kind === "chrome-connect") {
      if (chrome !== "none" || input.expectedBundleId !== "com.google.Chrome") context.addIssue({ code: "custom", message: "One exact Chrome connection per pipeline" })
      chrome = "pending"
    } else if (step.kind === "chrome-consent") {
      if (chrome !== "pending" || step.when.origin !== "native-dialog") context.addIssue({ code: "custom", message: "Consent requires a pending connection and native-dialog condition" })
      chrome = "consented"
    } else if (step.kind === "chrome-wait") {
      if (chrome !== "pending" && chrome !== "consented") context.addIssue({ code: "custom", message: "No pending Chrome connection" })
      chrome = "connected"
    } else if (step.kind === "chrome-read" || step.kind === "chrome-disconnect") {
      if (chrome !== "connected") context.addIssue({ code: "custom", message: "Chrome must be connected first" })
      if (step.kind === "chrome-disconnect") chrome = "closed"
    } else if ((chrome === "pending" || chrome === "consented") && step.kind !== "wait") {
      context.addIssue({ code: "custom", message: "Pending Chrome permits only guarded consent, not generic keyboard input" })
    }
  }
  if (chrome !== "none" && chrome !== "closed") context.addIssue({ code: "custom", message: "Connection pipeline must include disconnect" })
  if (!input.final.condition && !input.final.chromeDisconnected) context.addIssue({ code: "custom", message: "An explicit final condition is required" })
  if (input.final.chromeDisconnected && chrome !== "closed") context.addIssue({ code: "custom", message: "Missing Chrome disconnect step" })
})
export type PipelineInput = z.infer<typeof pipelineInputSchema>
const receiptSchema = z.strictObject({ id: stepId, kind: z.string(),
  state: z.enum(["observed", "dispatched", "pending", "completed", "stopped"]),
  operationIds: z.array(id).max(8), observedAt: z.string().optional(), selectedElementId: id.optional(),
  condition: z.enum(["matched", "not-found", "ambiguous", "unavailable"]).optional(), reason: z.string().max(2048).optional(),
})
const pipelineOutputSchema = z.strictObject({
  clientRequestId: id, runtimeEpoch: id, targetId: id,
  state: z.enum(["verified", "stopped"]),
  steps: z.array(receiptSchema).max(16),
  reads: z.array(z.strictObject({ targetId: id, url: z.string().max(4096), title: z.string().max(4096),
    mode: z.string(), contentBytes: z.number().int().min(0), sha256: z.string(), truncated: z.boolean() })).max(16),
  finalVerified: z.boolean(),
  connectionCleanup: z.enum(["not-started", "confirmed-disconnected", "unconfirmed"]),
  cleanupOperationIds: z.array(id).max(4),
  cleanupError: z.string().max(2048).optional(),
  failure: z.string().max(2048).optional(),
  connectionOperation: operationRecordSchema.optional(),
  finalObservation: agentObservedStateSchema.optional(),
  finalCaptureError: z.string().max(2048).optional(),
  frameRefs: z.array(id).max(1),
})
type Reply = z.infer<typeof pipelineOutputSchema>
type Receipt = z.infer<typeof receiptSchema>
type BrowserInstance = z.infer<typeof browserInstanceRefSchema>

function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2048) }
function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve() }, 80)
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) stop()
  })
}

/** Finite composition of existing public methods, not an evaluator or new task service.
 * Cache prevents replay of child mutations within the authenticated runtime lineage.
 * Restart requires a new explicit request with the new runtime epoch; no auto-resume. */
export function registerAgentPipelineMethods(registry: MethodRegistry, core: RuntimeCore, targets: AgentTargetRegistry): void {
  const replies = new Map<string, { digest: string, promise: Promise<Reply> }>()
  const busy = new Set<string>()
  core.subscribeLineageCleanup(lineage => {
    for (const key of replies.keys()) if ((JSON.parse(key) as string[])[0] === lineage) replies.delete(key)
  })
  registry.register("run_pipeline", {
    title: "Действия с локальными условиями",
    description: "Одна bounded последовательность существующих действий и ожиданий AX-ориентиров относительно окна. Никаких скриптов, увеличения Chrome timeout или повтора mutations. Неоднозначность/unknown останавливает шаги. Итог содержит дочерние операции и один кадр. OCR/OpenCV backend в этой версии не подключён.",
    input: pipelineInputSchema, output: pipelineOutputSchema,
    readOnly: false, destructive: true, timeoutMs: 30_000,
    maxRequestBytes: 128 * 1024, maxResponseBytes: 1024 * 1024,
    requiredCapabilities: ["runtime.operations", "desktop.ax", "desktop.windows.all", "input.readiness"],
    async execute(context, input) {
      if (input.runtimeEpoch !== core.generation.runtimeEpoch) throw new Error("Pipeline runtime epoch is stale; never replay after restart")
      const lineage = core.clients.lineage(context.session)
      const key = canonicalJson([lineage, input.clientRequestId]), digest = sha256(canonicalJson(input))
      const previous = replies.get(key)
      if (previous) {
        if (previous.digest !== digest) throw new Error("Pipeline request-payload-mismatch")
        return structuredClone(await previous.promise)
      }
      const target = targets.forLineage(lineage).resolveAction(input.targetId).target
      if (target.kind !== "window") throw new Error("Pipeline requires an exact native window target")
      const targetKey = canonicalJson(target)
      if (busy.has(targetKey)) throw new Error("Pipeline already controls this exact window")
      if (replies.size >= 128) throw new Error("Pipeline receipt capacity reached; old requests are not silently evicted")
      busy.add(targetKey)
      const pending = executePipeline(registry, core, context, input).finally(() => busy.delete(targetKey))
      replies.set(key, { digest, promise: pending })
      return structuredClone(await pending)
    },
    frames: result => result.frameRefs,
    isError: result => result.state !== "verified",
  })
}

async function executePipeline(registry: MethodRegistry, core: RuntimeCore, context: RuntimeMethodContext, input: PipelineInput): Promise<Reply> {
  const controller = new AbortController()
  bindDeadline(controller.signal, signalDeadline(context.signal) ?? Date.now() + 30_000)
  const abort = () => controller.abort(context.signal.reason)
  context.signal.addEventListener("abort", abort, { once: true })
  if (context.signal.aborted) abort()
  const unsubscribe = core.subscribeClientDisconnected(client => {
    if (client === context.session.clientSessionId) controller.abort("pipeline client disconnected")
  })
  const unsubscribeAdmission = core.subscribeAdmission(() => {
    if (core.admissionSealed) controller.abort("pipeline admission sealed")
  })
  const signal = controller.signal, session = context.session
  const reply: Reply = { clientRequestId: input.clientRequestId, runtimeEpoch: input.runtimeEpoch,
    targetId: input.targetId, state: "stopped", steps: [], reads: [], finalVerified: false,
    connectionCleanup: "not-started", cleanupOperationIds: [], frameRefs: [] }
  let connectId: string | undefined, connectRequestId: string | undefined
  let initial: BrowserInstance | undefined, connected: BrowserInstance | undefined
  let tab: BrowserTargetRef | undefined, disconnected = false
  let current: Receipt | undefined
  let cleaning = false
  const remember = (operationId: unknown) => {
    if (current && typeof operationId === "string" && !current.operationIds.includes(operationId)) current.operationIds.push(operationId)
    if (cleaning && typeof operationId === "string" && !reply.cleanupOperationIds.includes(operationId)) reply.cleanupOperationIds.push(operationId)
  }
  const checkpoint = () => {
    signal.throwIfAborted()
    if (Date.now() >= signalDeadline(signal)! || core.admissionSealed || input.runtimeEpoch !== core.generation.runtimeEpoch) throw new Error("Pipeline deadline/admission/generation changed")
  }
  const call = async (name: string, value: unknown): Promise<RuntimeMethodResponse> => {
    checkpoint()
    try {
      const result = await registry.dispatch(session, name, value, signal)
      remember(result.data.operationId)
      const record = operationRecordSchema.safeParse(result.data.operation)
      if (record.success) remember(record.data.context.operationId)
      if (result.isError) throw new Error(`${name}: ${message(record.success ? record.data.error?.message ?? record.data.state : result.data.error ?? "failed result; inspect child receipt")}`)
      return result
    } catch (error) {
      if (error instanceof RuntimeContractError) remember(error.contract.context?.operationId)
      throw error
    }
  }
  const windowReady = async () => {
    const state = (await call("get_state", { kind: "window" })).data
    const windows = state.windows as Array<{ targetId: string, pid: number, focused: string, visibility: string, hidden: string, minimized: string }>
    const apps = state.applications as Array<{ pid: number, bundleId?: string, axStatus: string }>
    const matches = windows.filter(w => w.targetId === input.targetId)
    const window = matches[0]
    if (matches.length !== 1 || !window || window.focused !== "true" || window.visibility !== "current"
      || window.hidden !== "false" || window.minimized !== "false") throw new Error("Unexpected window focus/visibility; no input sent")
    const owners = apps.filter(a => a.pid === window.pid)
    if (owners.length !== 1 || owners[0]!.bundleId !== input.expectedBundleId || owners[0]!.axStatus !== "ready") throw new Error("Exact window owner is not ready")
  }
  const liveConnect = async () => {
    if (!connectId) throw new Error("No own connection operation")
    const record = await core.getOperation(session, connectId)
    if (!record || !["registered", "dispatching", "observing"].includes(record.state)
      || Date.now() >= Date.parse(record.context.deadlineAt)) throw new Error("Connection no longer pending; consent must not be sent")
  }
  const condition = async (expected: PipelineCondition, consent = false) => {
    for (;;) {
      checkpoint()
      if (consent) await liveConnect()
      await windowReady()
      const observed = (await call("observe", { targetId: input.targetId, mode: "ax" })).data
      const match = matchPipelineCondition(observed, input.targetId, expected)
      if (current) { current.condition = match.state; current.observedAt = new Date().toISOString() }
      if (match.state === "matched") return match
      if (match.state !== "not-found") throw new Error(`${match.state}: ${match.reason}`)
      // Retry only a read, never the action preceding this expectation.
      await pause(signal)
    }
  }
  const browserInventory = async () => browserInstanceSnapshotSchema.parse((await call("browser_chrome_instances", {})).data)
  const browser = async (request: BrowserOperationRequest, snapshot: { inventoryId: string, inventoryRevision: number }, step: string, start = false) => {
    const childId = `pipeline-child:${sha256(canonicalJson([input.clientRequestId, step]))}`
    if (start) { connectRequestId = childId; reply.connectionCleanup = "unconfirmed" }
    const response = await call("browser_chrome_operation", {
      intent: { intent: request.kind.startsWith("read-") ? "read" : "mutation", clientRequestId: childId,
        precondition: { target: "instance" in request ? { kind: "browser-instance", ref: request.instance }
          : { kind: "browser-target", ref: request.target }, inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.inventoryRevision },
        deadlineAt: operationDeadline(signal, 30_000), requestedResources: browserOperationResources(request) },
      request, ...(start ? { waitForCompletion: false } : {}),
    })
    const record = operationRecordSchema.parse(response.data.operation)
    remember(record.context.operationId)
    if (!start && (record.state !== "completed" || record.outcome.cleanup.state !== "complete")) throw new Error("Browser operation did not complete with confirmed cleanup")
    return { record, data: response.data }
  }
  try {
    const health = (await call("system_health", {})).data
    if ((health.machine as { matchesExpected?: boolean } | undefined)?.matchesExpected !== true) throw new Error("Expected machine is not confirmed")
    for (const step of input.steps) {
      checkpoint()
      current = { id: step.id, kind: step.kind, state: "stopped", operationIds: [] }
      reply.steps.push(current)
      if (step.kind === "wait") {
        const matched = await condition(step.when)
        current.selectedElementId = matched.selected.elementId; current.state = "observed"
      } else if (step.kind === "keys" || step.kind === "press" || step.kind === "chrome-consent") {
        const readiness = (await call("check_input", {})).data
        if (readiness.inputReady !== true) throw new Error("Input readiness is not confirmed")
        const matched = await condition(step.when, step.kind === "chrome-consent")
        current.selectedElementId = matched.selected.elementId
        if (step.kind === "chrome-consent") await liveConnect()
        let action: RuntimeMethodResponse
        if (step.kind === "keys") action = await call("press_shortcut", { targetId: input.targetId, sequence: step.sequence, delayMs: 0 })
        else {
          if (!matched.selected.actions.includes("AXPress")) throw new Error("Matched element has no AXPress; no coordinate fallback")
          action = await call("click", { targetId: input.targetId, elementId: matched.selected.elementId })
        }
        const outcome = action.data.outcome as { state?: string, dispatch?: string, cleanup?: string }
        if (outcome?.state !== "completed" || outcome.dispatch !== "finished" || outcome.cleanup !== "complete") throw new Error("Input outcome unknown/partial; dependent steps stopped")
        current.state = "dispatched" // Delivery is not the application effect. The final condition verifies that.
      } else if (step.kind === "chrome-connect") {
        await windowReady()
        const snapshot = await browserInventory()
        const found = snapshot.instances.filter(i => structurallyEqual(i.ref, step.instance))
        if (!snapshot.complete || snapshot.errors.length || found.length !== 1 || found[0]!.state !== "disconnected") throw new Error("Exact disconnected Chrome instance required")
        initial = found[0]!.ref
        const started = await browser({ kind: "connect-instance", instance: initial }, snapshot, step.id, true)
        connectId = started.record.context.operationId
        current.state = started.data.pending === true ? "pending" : "completed"
      } else if (step.kind === "chrome-wait") {
        if (!connectId || !initial) throw new Error("Missing connection receipt")
        for (;;) {
          checkpoint()
          const record = await core.getOperation(session, connectId)
          if (!record) throw new Error("Connection receipt unavailable")
          if (record.state === "completed") break
          if (!["registered", "dispatching", "observing"].includes(record.state)) throw new Error(`Connect ${record.state}: ${record.error?.message ?? "unknown"}`)
          await pause(signal)
        }
        const snapshot = await browserInventory()
        const found = snapshot.instances.filter(i => i.ref.browserInstanceRef === initial!.browserInstanceRef && i.state === "connected")
        if (!snapshot.complete || found.length !== 1 || found[0]!.ref.transportGeneration === initial.transportGeneration) throw new Error("New connected transport is not confirmed")
        connected = found[0]!.ref
        const reservation = await core.reservations.inspect(session, { kind: "browser-instance", ref: connected })
        if (reservation?.state !== "active") throw new Error("Own active reservation required")
        remember(connectId); current.state = "completed"
      } else if (step.kind === "chrome-read") {
        if (!connected) throw new Error("Missing active Chrome instance")
        const snapshot = browserTargetSnapshotSchema.parse((await call("browser_chrome_targets", { instance: connected })).data)
        const found = snapshot.targets.filter(t => t.url === step.url && (!tab || structurallyEqual(t.ref, tab)))
        if (!snapshot.complete || snapshot.errors.length || found.length !== 1) throw new Error("Exact unique tab required; never choose first or retarget")
        tab ??= found[0]!.ref
        const read = await browser(step.mode === "dom" ? { kind: "read-dom", target: tab, maxBytes: 32_768 }
          : { kind: "read-accessibility", target: tab, maxBytes: 32_768, maxNodes: 300 }, snapshot, step.id)
        const result = read.data.result as { ok?: boolean, value?: { value?: { content?: string, contentBytes?: number, truncated?: boolean } } }
        const value = result.value?.value
        if (result.ok !== true || typeof value?.content !== "string" || typeof value.contentBytes !== "number" || typeof value.truncated !== "boolean") throw new Error("Invalid browser read result")
        reply.reads.push({ targetId: tab.targetId, url: step.url, title: found[0]!.title.slice(0, 4096),
          mode: step.mode, contentBytes: value.contentBytes, sha256: sha256(value.content), truncated: value.truncated })
        current.state = "completed"
      } else if (step.kind === "chrome-disconnect") {
        if (!connected) throw new Error("No owned connected instance")
        const snapshot = await browserInventory()
        if (!snapshot.complete || !snapshot.instances.some(i => structurallyEqual(i.ref, connected) && i.state === "connected")) throw new Error("Connected instance changed")
        await browser({ kind: "disconnect-instance", instance: connected }, snapshot, step.id)
        const after = await browserInventory()
        if (!after.complete || !after.instances.some(i => i.ref.browserInstanceRef === connected!.browserInstanceRef && i.state === "disconnected")) throw new Error("Disconnect effect is not confirmed")
        disconnected = true; reply.connectionCleanup = "confirmed-disconnected"; current.state = "completed"
      }
    }
    current = undefined
    if (input.final.condition) await condition(input.final.condition)
    if (input.final.chromeDisconnected && !disconnected) throw new Error("Final Chrome condition failed")
    reply.finalVerified = true; reply.state = "verified"
  } catch (error) {
    reply.failure = message(error)
    if (current) { current.state = "stopped"; current.reason = reply.failure }
  } finally {
    current = undefined
    // Resolve only our deterministic connection request, including a lost start reply.
    if (!connectId && connectRequestId) connectId = (await core.getOperationByRequest(session, connectRequestId).catch(() => undefined))?.context.operationId
    if (connectId) {
      let record = await core.getOperation(session, connectId).catch(() => undefined)
      if (reply.state !== "verified" && record && ["registered", "dispatching", "observing"].includes(record.state)) {
        record = await core.cancelOperation(session, connectId, "pipeline stopped").catch(() => record)
      }
      if (record) reply.connectionOperation = record
    }
    // The requested plan already includes disconnect. On failure, attempt it once
    // only for the exact active reservation we observed, within the original budget.
    // Pending/unknown transports are never blindly disconnected or reconnected here.
    if (reply.state !== "verified" && connected && !disconnected && !signal.aborted) {
      cleaning = true
      try {
        const reservation = await core.reservations.inspect(session, { kind: "browser-instance", ref: connected })
        if (reservation?.state !== "active") throw new Error("Cleanup requires own exact active reservation")
        const before = await browserInventory()
        if (!before.complete || !before.instances.some(i => structurallyEqual(i.ref, connected) && i.state === "connected")) throw new Error("Cleanup instance changed")
        await browser({ kind: "disconnect-instance", instance: connected }, before, "pipeline-cleanup-disconnect")
        const after = await browserInventory()
        if (!after.complete || !after.instances.some(i => i.ref.browserInstanceRef === connected!.browserInstanceRef && i.state === "disconnected")) throw new Error("Cleanup effect unconfirmed")
        reply.connectionCleanup = "confirmed-disconnected"
      } catch (error) { reply.cleanupError = message(error) }
      finally { cleaning = false }
    }
    try {
      const capture = await call("observe", { targetId: input.targetId,
        mode: reply.finalVerified && input.final.condition ? "both" : "screenshot", caption: input.final.caption })
      reply.finalObservation = agentObservedStateSchema.parse(capture.data)
      reply.frameRefs = capture.frameRefs.slice(0, 1)
      if (reply.finalVerified && input.final.condition) {
        const rechecked = matchPipelineCondition(capture.data, input.targetId, input.final.condition)
        if (rechecked.state !== "matched") {
          reply.finalVerified = false; reply.state = "stopped"
          reply.failure = `Final observation ${rechecked.state}: ${rechecked.reason}`.slice(0, 2048)
        }
      }
    } catch (error) {
      reply.finalCaptureError = message(error)
      if (reply.finalVerified && input.final.condition) {
        reply.state = "stopped"; reply.finalVerified = false
        reply.failure = "Final combined observation is unavailable"
      }
    }
    context.signal.removeEventListener("abort", abort); unsubscribe(); unsubscribeAdmission()
  }
  return pipelineOutputSchema.parse(reply)
}
