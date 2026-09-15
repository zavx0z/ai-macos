import {
  OPERATION_STATES,
  dispatchStateSchema,
  structurallyEqual,
  z,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import { keyActionSchema, textActionSchema, shortcutActionSchema } from "@meta/input/actions"
import { planKey, planShortcuts } from "@meta/input/action-plan"
import { AgentOperations, type AgentOperationOutcome } from "./agent-operations.ts"
import { agentTargetIdSchema, internalMethodError, type RuntimeAgentMethods } from "./agent-methods.ts"
import type { InputMethodOutput } from "./input-methods.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"

const actionOutcomeSchema = z.strictObject({
  state: z.enum(OPERATION_STATES),
  dispatch: dispatchStateSchema,
  cleanup: z.enum(["pending", "complete", "incomplete", "unknown"]),
  effect: z.enum(["unverified", "verified"]),
  updatedAt: z.iso.datetime({ offset: true }),
  error: z.strictObject({ code: z.string(), recoveryAction: z.string() }).optional(),
})

const operationViewSchema = z.strictObject({
  trackingId: agentTargetIdSchema,
  action: agentTargetIdSchema,
  targetId: agentTargetIdSchema,
  queuedAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  handlerSettledAt: z.iso.datetime({ offset: true }).optional(),
  cancellationRequestedAt: z.iso.datetime({ offset: true }).optional(),
  phase: z.enum([
    "queued",
    "pending-handler",
    "pending-core",
    "cancelled-before-admission",
    "failed-before-admission",
    "terminal",
  ]),
  operationId: agentTargetIdSchema.optional(),
  outcome: actionOutcomeSchema.optional(),
  localFailure: z.enum(["cancelled-before-admission", "handler-error", "missing-operation-record"]).optional(),
})

const targetStatusSchema = z.strictObject({
  targetId: agentTargetIdSchema,
  targetState: z.enum(["active", "closed", "invalidated", "retained-operation"]),
  targetReason: z.string().max(1_024).optional(),
  active: z.array(operationViewSchema).max(128),
  recent: z.array(operationViewSchema).max(64),
  retentionMs: z.number().int().safe().positive(),
})

const actionResultSchema = z.strictObject({
  targetId: agentTargetIdSchema,
  operationId: agentTargetIdSchema,
  outcome: actionOutcomeSchema,
})

const pressKeyInputSchema = z.strictObject({
  targetId: agentTargetIdSchema,
  key: keyActionSchema.shape.key,
  modifiers: keyActionSchema.shape.modifiers,
}).superRefine((input, context) => {
  try {
    planKey(input.key, input.modifiers)
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["key"],
      message: error instanceof Error ? error.message : "Клавиша или modifiers не входят в действующий macOS key grammar",
    })
  }
})

/** Регистрирует короткие mutation/control методы поверх RuntimeCore и AgentOperations. */
export class RuntimeAgentActionMethods {
  constructor(
    private readonly registry: MethodRegistry,
    private readonly methods: RuntimeAgentMethods,
    private readonly operations: AgentOperations = methods.operations,
  ) {}

  register(): void {
    this.registry.register("type_text", {
      title: "Ввести текст",
      description: "Вводит текст в точное существующее окно после отдельно выполненного input_readiness.",
      input: z.strictObject({ targetId: agentTargetIdSchema, text: textActionSchema.shape.text }),
      output: actionResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 35_000,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4096,
      requiredCapabilities: ["desktop.windows.all", "input.keyboard", "input.readiness", "runtime.operations"],
      execute: (context, input) => this.#keyboardAction(
        context.session,
        input.targetId,
        "type-text",
        { kind: "text", text: input.text },
        "keyboard_type",
        context.signal,
      ),
    })

    this.registry.register("press_key", {
      title: "Нажать клавишу",
      description: "Передаёт одну клавишу действующего macOS key grammar в точное окно после input_readiness.",
      input: pressKeyInputSchema,
      output: actionResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4096,
      requiredCapabilities: ["desktop.windows.all", "input.keyboard", "input.readiness", "runtime.operations"],
      execute: (context, input) => this.#keyboardAction(
        context.session,
        input.targetId,
        "press-key",
        { kind: "key", key: input.key, modifiers: input.modifiers },
        "keyboard_key",
        context.signal,
      ),
    })

    this.registry.register("press_shortcut", {
      title: "Выполнить последовательность клавиш",
      description: "Выполняет bounded shortcut sequence одной Core operation по fresh view; после неё требуется новый observe.",
      input: z.strictObject({ targetId: agentTargetIdSchema, sequence: shortcutActionSchema.shape.shortcuts,
        delayMs: shortcutActionSchema.shape.delayMs }).superRefine((input, context) => {
        try { planShortcuts({ shortcuts: input.sequence, delayMs: input.delayMs }) }
        catch (error) { context.addIssue({ code: "custom", path: ["sequence"], message: error instanceof Error ? error.message : "Invalid shortcut sequence" }) }
      }),
      output: actionResultSchema, readOnly: false, destructive: true, timeoutMs: 10_000,
      maxRequestBytes: 64 * 1024, maxResponseBytes: 4096,
      requiredCapabilities: ["desktop.windows.all", "input.keyboard", "input.readiness", "runtime.operations"],
      execute: (context, input) => this.#keyboardAction(context.session, input.targetId, "press-shortcut",
        { kind: "shortcut", shortcuts: input.sequence, delayMs: input.delayMs }, "keyboard_shortcut", context.signal),
    })

    this.registry.register("get_target_status", {
      title: "Состояние действий цели",
      description: "Возвращает bounded authoritative outcome действий текущей client lineage.",
      input: z.strictObject({ targetId: agentTargetIdSchema }),
      output: targetStatusSchema,
      readOnly: true,
      availableDuringDrain: true,
      maxResponseBytes: 256 * 1024,
      requiredCapabilities: ["runtime.operations"],
      execute: async (context, input) => targetStatusSchema.parse(
        await this.operations.getTargetStatus(context.session, input.targetId),
      ),
    })

    this.registry.register("cancel_target", {
      title: "Отменить действия цели",
      description: "Отменяет queued/active действия только этой client lineage и возвращает подтверждённый status.",
      input: z.strictObject({
        targetId: agentTargetIdSchema,
        reason: z.string().min(1).max(1_024).default("user-requested"),
      }),
      output: targetStatusSchema,
      readOnly: false,
      destructive: true,
      availableDuringDrain: true,
      timeoutMs: 10_000,
      maxResponseBytes: 256 * 1024,
      requiredCapabilities: ["runtime.operations"],
      execute: async (context, input) => targetStatusSchema.parse(
        await this.operations.cancelTarget(context.session, input.targetId, input.reason),
      ),
    })
  }

  async #keyboardAction(
    session: RuntimeClientSession,
    targetId: string,
    actionName: "type-text" | "press-key" | "press-shortcut",
    action: { kind: "text", text: string } | { kind: "key", key: string, modifiers: string[] } | { kind: "shortcut", shortcuts: string[], delayMs: number },
    method: "keyboard_type" | "keyboard_key" | "keyboard_shortcut",
    signal: AbortSignal,
  ) {
    return actionResultSchema.parse(await this.operations.runTrackedMutation(
      session,
      targetId,
      actionName,
      async context => {
        const binding = await this.methods.refreshNativeAction(
          session,
          targetId,
          context.binding,
          context.signal,
        )
        if (binding.target.kind !== "window" && binding.target.kind !== "surface") throw new Error("Keyboard action требует exact window/surface target")
        const response = await this.methods.withViewAction(session, targetId, context.clientRequestId, "keyboard", () => this.#dispatch(session, method, {
          clientRequestId: context.clientRequestId,
          precondition: {
            target: binding.target,
            inventoryId: binding.inventoryId,
            inventoryRevision: binding.inventoryRevision,
          },
          action,
        }, context.signal))
        const output = response.data as InputMethodOutput
        if (
          output.operation.context.clientRequestId !== context.clientRequestId
          || output.operation.context.inventoryId !== binding.inventoryId
          || output.operation.context.inventoryRevision !== binding.inventoryRevision
          || !structurallyEqual(output.operation.context.target, binding.target)
        ) {
          throw new Error("Internal keyboard operation не совпадает с agent target binding")
        }
        return {
          targetId,
          operationId: output.operation.context.operationId,
          outcome: projectOutcome(output.operation),
        }
      },
      signal,
    ))
  }

  async #dispatch(
    session: RuntimeClientSession,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<RuntimeMethodResponse> {
    signal.throwIfAborted()
    const response = await this.registry.internal.dispatch(session, name, input, signal)
    if (response.isError) throw internalMethodError(response, name)
    return response
  }
}

export function registerAgentActionMethods(
  registry: MethodRegistry,
  methods: RuntimeAgentMethods,
  operations: AgentOperations = methods.operations,
): RuntimeAgentActionMethods {
  const actions = new RuntimeAgentActionMethods(registry, methods, operations)
  actions.register()
  return actions
}

function projectOutcome(operation: InputMethodOutput["operation"]): AgentOperationOutcome {
  return {
    state: operation.state,
    dispatch: operation.outcome.dispatch,
    cleanup: operation.outcome.cleanup.state,
    effect: operation.outcome.effect.state,
    updatedAt: operation.updatedAt,
    ...(operation.error === undefined ? {} : {
      error: { code: operation.error.code, recoveryAction: operation.error.recoveryAction },
    }),
  }
}
