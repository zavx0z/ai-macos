import { operationDeadline } from "./deadline.ts"
import {
  freezeAdapterHostContext, operationOutcomeSchema, runtimeOperationIntentSchema, structurallyEqual,
  type AdapterResult, type ClipboardExecutionContext, type RuntimeClientSession,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  clipboardAdapterResultSchema, clipboardRequestSchema, SystemClipboardAdapter,
  type ClipboardRequest, type ClipboardResult,
} from "@meta/input/clipboard-adapter"
import { NativeVersionedClipboardBackend, type ClipboardBackendReport, type NativeClipboardClient } from "@meta/input/native-clipboard-backend"
import type { RuntimeCore, BackendCompletionVerifier } from "./core.ts"

export class RuntimeClipboardHandler implements BackendCompletionVerifier {
  readonly #core: RuntimeCore
  readonly #backend: NativeVersionedClipboardBackend
  readonly #adapter: SystemClipboardAdapter
  readonly #reports = new Map<string, ClipboardBackendReport>()
  readonly #terminalReports = new Map<string, number>()

  constructor(core: RuntimeCore, native: NativeClipboardClient) {
    this.#core = core
    this.#backend = new NativeVersionedClipboardBackend(native)
    this.#adapter = new SystemClipboardAdapter(freezeAdapterHostContext({
      generation: core.generation, runtimeBuildId: "runtime:clipboard-handler",
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: native.adapterInstanceRef,
        capabilities: [{ id: "input.clipboard", state: "ready" }] },
    }), core.services, this.#backend)
  }

  async execute(session: RuntimeClientSession, clientRequestId: string, requestValue: ClipboardRequest, signal?: AbortSignal) {
    const request = clipboardRequestSchema.parse(requestValue)
    const existing = await this.#core.getOperationByRequest(session, clientRequestId)
    if (existing === undefined) {
      for (const [id, timestamp] of this.#terminalReports) {
        if (Date.now() - timestamp >= 86_400_000 || this.#reports.size >= 10_000) {
          this.#reports.delete(id)
          this.#terminalReports.delete(id)
        }
      }
      if (this.#reports.size - this.#terminalReports.size >= 100 || this.#reports.size >= 10_000) {
        throw new Error("Clipboard receipt budget исчерпан; unresolved metadata требует recovery")
      }
    }
    const target = { kind: "clipboard" as const, ref: { ...this.#core.generation, clipboardRef: "system" as const } }
    this.#core.targets.register(target, "inventory:clipboard", 0, "resolution:clipboard", "proof:clipboard", 0)
    const intent = runtimeOperationIntentSchema.parse({
      intent: request.kind === "read" ? "read" : "mutation", clientRequestId,
      precondition: { target, inventoryId: "inventory:clipboard", inventoryRevision: 0 },
      deadlineAt: operationDeadline(signal, 5000),
      requestedResources: [{ kind: "clipboard", resourceRef: "system" }],
    })
    return this.#core.runOperation(session, intent, request, async (context, value) => {
      if (context.wire.kind !== "clipboard") throw new Error("Clipboard context expected")
      const response = clipboardAdapterResultSchema.parse(await this.#adapter.execute({ ...context, wire: context.wire }, value))
      const report = response.clipboard
      if (report.authority === "verified-response") {
        await this.#backend.verifyReport(report)
        assertReportContext(context as RuntimeOperationContext<ClipboardExecutionContext>, report)
      }
      const safe = report.authority === "verified-response" && [
        "ok", "text-unavailable", "changed-during-read", "written", "precondition-mismatch-no-dispatch",
      ].includes(report.status)
      const cleanup = {
        scope: "owned" as const,
        state: safe ? "complete" as const : "unknown" as const,
        ...(safe ? {} : { reason: "Clipboard backend completion не подтверждает safe release" }),
        resources: context.resources.map(handle => ({ handle, outcome: safe ? "released" as const : "quarantined" as const })),
      }
      const outcome = operationOutcomeSchema.parse({ ...response.outcome, cleanup })
      this.#reports.set(context.wire.operationId, structuredClone(report))
      return response.ok
        ? { ok: true as const, value: response.value, outcome }
        : { ok: false as const, error: response.error, outcome }
    }, signal)
  }

  async verify(context: RuntimeOperationContext, result: AdapterResult<unknown>): Promise<void> {
    if (context.wire.kind !== "clipboard") throw new Error("Clipboard verifier получил другой domain")
    const report = this.#reports.get(context.wire.operationId)
    if (report === undefined) throw new Error("Clipboard report не зарегистрирован handler")
    if (result.outcome.cleanup.state === "complete") {
      await this.#backend.verifyReport(report)
      assertReportContext({ ...context, wire: context.wire }, report)
      this.#terminalReports.set(context.wire.operationId, Date.now())
    }
  }

  report(operationId: string): ClipboardBackendReport | undefined {
    const report = this.#reports.get(operationId)
    return report === undefined ? undefined : structuredClone(report)
  }
}

function assertReportContext(context: RuntimeOperationContext<ClipboardExecutionContext>, report: ClipboardBackendReport): void {
  const receipt = report.receipt
  if (receipt === undefined || receipt.operationId !== context.wire.operationId
    || receipt.runtimeEpoch !== context.wire.runtimeEpoch || receipt.loginSessionId !== context.wire.loginSessionId) {
    throw new Error("Clipboard receipt не совпадает с runtime operation")
  }
}
