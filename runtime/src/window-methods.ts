import {
  adapterResultSchema, axInspectionRequestSchema, axInspectionResultSchema, axInspectionTargetSchema, axPressRequestSchema, axPressResultSchema,
  desktopInventorySnapshotSchema, opaqueIdSchema, operationRecordSchema,
  runtimeOperationIntentSchema, windowTransitionRequestSchema, windowTransitionResultSchema, z,
  type AdapterResult, type AxPressRequest, type AxPressResult, type NativeExecutionContext,
  type RuntimeOperationContext, type WindowAdapter,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry } from "./method-registry.ts"

const snapshotInput = {
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
}
const transitionOutput = z.strictObject({
  operation: operationRecordSchema,
  result: adapterResultSchema(windowTransitionResultSchema),
})

export const axPressMethodInputSchema = z.strictObject({
  clientRequestId: opaqueIdSchema,
  precondition: z.strictObject({
    target: axInspectionTargetSchema,
    inventoryId: opaqueIdSchema,
    inventoryRevision: z.number().int().safe().min(0),
  }),
  request: axPressRequestSchema,
}).superRefine((input, context) => {
  const window = input.precondition.target.ref
  const element = input.request.element
  if (
    element.runtimeEpoch !== window.runtimeEpoch
    || element.loginSessionId !== window.loginSessionId
    || element.nativeGeneration !== window.nativeGeneration
    || element.applicationRef !== window.applicationRef
  ) {
    context.addIssue({ code: "custom", path: ["request", "element"], message: "AX element не принадлежит exact parent window/surface" })
  }
})

export const axPressExecutionSchema = z.strictObject({
  operation: operationRecordSchema,
  result: adapterResultSchema(axPressResultSchema),
})

export type AxPressMethodOutput = z.infer<typeof axPressExecutionSchema>

export type RuntimeWindowAdapter = WindowAdapter & {
  press?(
    context: RuntimeOperationContext<NativeExecutionContext>,
    request: AxPressRequest,
  ): Promise<AdapterResult<AxPressResult>>
}

/** Каталог использует точные refs из inventory; resources и fence выдаёт runtime. */
export function registerWindowMethods(registry: MethodRegistry, core: RuntimeCore, windows: RuntimeWindowAdapter, options: { internalAgentMethods?: boolean } = {}): void {
  registry.register("list_windows", {
    visibility: options.internalAgentMethods ? "internal" : "public",
    title: "Окна и приложения",
    description: "Полная инвентаризация AX и CG-only окон, включая скрытые и свёрнутые. app — точное системное имя; pid различает одноимённые процессы.",
    input: z.strictObject({ app: z.string().min(1).max(1024).optional(), pid: z.number().int().min(1).max(0x7fffffff).optional() }),
    output: desktopInventorySnapshotSchema,
    readOnly: true,
    timeoutMs: 6000,
    requiredCapabilities: ["desktop.windows.all", "desktop.applications", "desktop.displays"],
    async execute(context, input) {
      const inventory = await windows.inventory(control(context.signal))
      if (input.app === undefined && input.pid === undefined) return inventory
      const applications = inventory.applications.filter(application =>
        (input.app === undefined || application.name === input.app)
        && (input.pid === undefined || application.ref.pid === input.pid))
      const pids = new Set(applications.map(application => application.ref.pid))
      return { ...inventory, applications, windows: inventory.windows.filter(window => pids.has(window.ownerPid)) }
    },
  })

  registry.register("window_transition", {
    title: "Показ и изменение окна",
    description: "Показывает, фокусирует, перемещает, сворачивает или закрывает точное AX окно из указанной inventory. Возвращает requested, actual и partial; повтор clientRequestId не повторяет действие.",
    input: z.strictObject({ ...snapshotInput, clientRequestId: opaqueIdSchema, request: windowTransitionRequestSchema }),
    output: transitionOutput,
    readOnly: false,
    destructive: true,
    timeoutMs: 8000,
    requiredCapabilities: ["desktop.window.identity", "desktop.window.show", "desktop.window.lifecycle"],
    async execute(context, input) {
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation", clientRequestId: input.clientRequestId,
        precondition: { target: { kind: "window", ref: input.request.target },
          inventoryId: input.inventoryId, inventoryRevision: input.inventoryRevision },
        deadlineAt: new Date(Date.now() + 6000).toISOString(),
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return core.runOperation(context.session, intent, input.request, (operation, request) => {
        if (operation.wire.kind !== "native") throw new Error("Window transition требует native context")
        return windows.transition({ ...operation, wire: operation.wire }, request)
      }, context.signal)
    },
    isError: output => !output.result.ok || output.result.value.partial,
  })

  registry.register("inspect_accessibility", {
    visibility: options.internalAgentMethods ? "internal" : "public",
    title: "Дерево Accessibility",
    description: "Читает bounded AX snapshot точного окна или sheet. Element refs действуют только в возвращённом snapshot; неполный результат явно помечен.",
    input: z.strictObject({ ...snapshotInput, request: axInspectionRequestSchema }),
    output: axInspectionResultSchema,
    readOnly: true,
    timeoutMs: 6000,
    requiredCapabilities: ["desktop.ax"],
    async execute(context, input) {
      await core.targets.resolve({
        target: input.request.target, inventoryId: input.inventoryId, inventoryRevision: input.inventoryRevision,
        ...core.generation, nativeGeneration: input.request.target.ref.nativeGeneration,
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      })
      const result = await windows.inspect(input.request, control(context.signal))
      return axInspectionResultSchema.parse(result)
    },
  })

  if (windows.press === undefined) return
  const press = windows.press.bind(windows)
  registry.register("press_accessibility", {
    visibility: options.internalAgentMethods ? "internal" : "public",
    title: "Выполнить AXPress",
    description: "Выполняет semantic AXPress точного ElementRef из retained snapshot без координатного fallback.",
    input: axPressMethodInputSchema,
    output: axPressExecutionSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: 10_000,
    requiredCapabilities: ["desktop.window.identity", "desktop.ax", "runtime.operations"],
    async execute(context, input) {
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: input.clientRequestId,
        precondition: input.precondition,
        deadlineAt: new Date(Date.now() + 8_000).toISOString(),
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return core.runOperation(context.session, intent, input.request, (operation, request) => {
        if (operation.wire.kind !== "native") throw new Error("AXPress требует native context")
        return press({ ...operation, wire: operation.wire }, request)
      }, context.signal)
    },
    isError: output => !output.result.ok,
  })
}

function control(signal: AbortSignal) {
  return { signal, checkpoint() { signal.throwIfAborted() } }
}
