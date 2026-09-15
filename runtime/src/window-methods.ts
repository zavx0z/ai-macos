import {
  adapterResultSchema, axInspectionRequestSchema, axInspectionResultSchema,
  desktopInventorySnapshotSchema, opaqueIdSchema, operationRecordSchema,
  runtimeOperationIntentSchema, windowTransitionRequestSchema, windowTransitionResultSchema, z,
  type WindowAdapter,
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

/** Каталог использует точные refs из inventory; resources и fence выдаёт runtime. */
export function registerWindowMethods(registry: MethodRegistry, core: RuntimeCore, windows: WindowAdapter): void {
  registry.register("list_windows", {
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
}

function control(signal: AbortSignal) {
  return { signal, checkpoint() { signal.throwIfAborted() } }
}
