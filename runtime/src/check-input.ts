import {
  adapterResultSchema, desktopInventorySnapshotSchema, inputReadinessDiagnosticFields,
  operationRecordSchema, structurallyEqual, z,
  rectContainsPoint,
  type NativeAdapter, type RuntimeClientSession, type WindowAdapter,
} from "@meta/shared/contracts"
import {
  nativeCursorDisplayRequestSchema, nativeCursorDisplayResponseSchema, nativeCursorDisplayResultMatches,
  nativeInputReadinessResultSchema,
} from "@meta/native/protocol"
import type { MethodRegistry } from "./method-registry.ts"
import { inputReadinessMethodInputSchema } from "./readiness-methods.ts"

const executionSchema = z.strictObject({ operation: operationRecordSchema, result: adapterResultSchema(nativeInputReadinessResultSchema) })
const checksSchema = z.strictObject(inputReadinessDiagnosticFields)
export const checkInputResultSchema = z.strictObject({
  inputReady: z.boolean(),
  probe: z.enum(["not-run", "active-event"]),
  operationId: z.string().min(1).max(127).optional(),
  reason: z.string().min(1).max(2048).optional(),
  checks: checksSchema.optional(),
}).superRefine((value, context) => {
  if (value.inputReady && (value.probe !== "active-event" || value.operationId === undefined || value.checks === undefined
    || value.checks.quarantined || value.checks.cleanup !== "complete" || value.checks.restoration !== "restored"
    || !value.checks.movePosted || !value.checks.moveObserved || !value.checks.moveReadbackConfirmed
    || !value.checks.restorePosted || !value.checks.restoreObserved || !value.checks.restoreReadbackConfirmed)) {
    context.addIssue({ code: "custom", message: "Input ready требует реальный подтверждённый probe" })
  }
  if (!value.inputReady && value.reason === undefined) context.addIssue({ code: "custom", message: "Not-ready требует причину" })
})
export type CheckInputResult = z.infer<typeof checkInputResultSchema>

/** Отдельный explicit вызов: passive selection, затем ровно один Core readiness probe. */
export function registerCheckInputMethod(registry: MethodRegistry, dependencies: {
  native: Pick<NativeAdapter, "request" | "generation">
  windows: Pick<WindowAdapter, "inventory">
  now?: () => Date
  requestId?: () => string
}): void {
  const native = dependencies.native
  const inventory = dependencies.windows.inventory.bind(dependencies.windows)
  const now = dependencies.now ?? (() => new Date())
  const requestId = dependencies.requestId ?? (() => `check-input:${crypto.randomUUID()}`)
  registry.register("check_input", {
    title: "Проверить ввод",
    description: "Выбирает display по текущему cursor без ввода, затем выполняет один active probe с подтверждённым возвратом указателя.",
    input: z.strictObject({}), output: checkInputResultSchema,
    readOnly: false, destructive: false, timeoutMs: 15_000,
    requiredCapabilities: ["input.readiness", "runtime.operations", "desktop.displays"],
    isError: output => !output.inputReady,
    async execute(context) {
      const generation = native.generation
      if (generation === undefined) return notRun("Native generation недоступна")
      const control = { signal: context.signal, checkpoint() { context.signal.throwIfAborted() } }
      let selected
      let snapshot
      try {
        snapshot = desktopInventorySnapshotSchema.parse(await inventory(control))
        if (snapshot.runtimeEpoch !== generation.runtimeEpoch || snapshot.loginSessionId !== generation.loginSessionId
          || snapshot.nativeGeneration !== generation.nativeGeneration) throw new Error("Display inventory принадлежит другой Native generation")
        control.checkpoint()
        const request = nativeCursorDisplayRequestSchema.parse({
          kind: "request", protocolVersion: "1", requestId: requestId(), ...generation,
          deadlineAt: new Date(now().getTime() + 1000).toISOString(), intent: "read", method: "input.cursor-display",
          payload: { inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.revision, displayLayoutRevision: snapshot.displayLayoutRevision },
        })
        const response = await native.request(nativeCursorDisplayRequestSchema, request, nativeCursorDisplayResponseSchema, control)
        control.checkpoint()
        if (!response.ok) return notRun(response.error.message)
        if (!nativeCursorDisplayResultMatches(request, response.result)) throw new Error("Cursor resolver вернул другую snapshot identity")
        if (response.result.status !== "resolved") return notRun(response.result.reason)
        const result = response.result
        const age = now().getTime() - Date.parse(result.observedAt)
        const containing = snapshot.displays.filter(display => rectContainsPoint(display.bounds, result.cursor))
        if (age < -1000 || age > 1000 || containing.length !== 1 || !structurallyEqual(containing[0]!.ref, result.displayRef)
          || !structurallyEqual(native.generation, generation)) throw new Error("Cursor display не подтверждён fresh inventory")
        selected = result.displayRef
      } catch (error) {
        context.signal.throwIfAborted()
        return notRun(error instanceof Error ? error.message : "Cursor display unavailable")
      }
      control.checkpoint()
      return executeProbe(registry, context.session, {
        clientRequestId: requestId(), precondition: { target: { kind: "display", ref: selected },
          inventoryId: snapshot.inventoryId, inventoryRevision: snapshot.revision },
      }, context.signal)
    },
  })
}

async function executeProbe(registry: MethodRegistry, session: RuntimeClientSession, args: z.infer<typeof inputReadinessMethodInputSchema>, signal: AbortSignal): Promise<CheckInputResult> {
  const response = await registry.dispatch(session, "input_readiness", args, signal)
  const execution = executionSchema.parse(response.data)
  if (execution.operation.clientSessionId !== session.clientSessionId || execution.operation.principalId !== session.principalId
    || execution.operation.context.clientRequestId !== args.clientRequestId
    || execution.operation.context.inventoryId !== args.precondition.inventoryId
    || execution.operation.context.inventoryRevision !== args.precondition.inventoryRevision
    || !structurallyEqual(execution.operation.context.target, args.precondition.target)) throw new Error("Readiness operation относится к другому caller/target")
  const operationId = execution.operation.context.operationId
  if (!execution.result.ok) {
    const diagnostic = execution.result.error.context?.inputReadiness
    return checkInputResultSchema.parse({ inputReady: false, probe: "active-event", operationId,
      reason: execution.result.error.message,
      ...(diagnostic === undefined ? {} : { checks: projectChecks(diagnostic) }),
    })
  }
  if (execution.operation.state !== "completed" || execution.operation.outcome.cleanup.state !== "complete") throw new Error("Readiness operation не подтверждена Core")
  const value = execution.result.value
  if (value.operationId !== operationId || !structurallyEqual(value.expectedDisplayRef, args.precondition.target.ref)) throw new Error("Readiness result относится к другому display/operation")
  return checkInputResultSchema.parse({ inputReady: value.inputReady, probe: "active-event", operationId,
    checks: projectChecks(value), ...(value.reason === undefined ? {} : { reason: value.reason }) })
}

function projectChecks(value: z.infer<typeof checksSchema>) {
  return checksSchema.parse(Object.fromEntries(Object.keys(inputReadinessDiagnosticFields).map(key => [key, value[key as keyof typeof value]])))
}
function notRun(reason: string): CheckInputResult { return { inputReady: false, probe: "not-run", reason: reason.slice(0, 2048) || "Cursor display unavailable" } }
