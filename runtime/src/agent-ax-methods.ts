import {
  OPERATION_STATES,
  axPressResultMatches,
  dispatchStateSchema,
  structurallyEqual,
  z,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import { AgentOperations, type AgentOperationOutcome } from "./agent-operations.ts"
import { agentTargetIdSchema, type RuntimeAgentMethods } from "./agent-methods.ts"
import type { AgentTargetRegistry } from "./agent-targets.ts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"
import type { AxPressMethodOutput } from "./window-methods.ts"
import { agentImagePointSchema, type AgentImagePoint, type AgentPointClickHandler, type AgentPointClickOptions } from "./agent-pointer-methods.ts"

const actionOutcomeSchema = z.strictObject({
  state: z.enum(OPERATION_STATES),
  dispatch: dispatchStateSchema,
  cleanup: z.enum(["pending", "complete", "incomplete", "unknown"]),
  effect: z.enum(["unverified", "verified"]),
  updatedAt: z.iso.datetime({ offset: true }),
  error: z.strictObject({ code: z.string(), recoveryAction: z.string() }).optional(),
})

const clickResultSchema = z.strictObject({
  targetId: agentTargetIdSchema,
  operationId: agentTargetIdSchema,
  outcome: actionOutcomeSchema,
})

type AgentClickInput = AgentPointClickOptions & { targetId: string, elementId?: string, point?: AgentImagePoint }

/** Регистрирует AXPress по elementId и явно выбранный клик по точке снимка. */
export class RuntimeAgentAxMethods {
  constructor(
    private readonly registry: MethodRegistry,
    private readonly core: RuntimeCore,
    private readonly targets: AgentTargetRegistry,
    private readonly methods: RuntimeAgentMethods,
    private readonly operations: AgentOperations = methods.operations,
    private readonly pointer?: AgentPointClickHandler,
  ) {}

  register(): void {
    const input: z.ZodType<AgentClickInput> = this.pointer === undefined
      ? z.strictObject({ targetId: agentTargetIdSchema, elementId: agentTargetIdSchema }) as z.ZodType<AgentClickInput>
      : z.strictObject({
          targetId: agentTargetIdSchema,
          elementId: agentTargetIdSchema.optional(),
          point: agentImagePointSchema.optional(),
          button: z.enum(["left", "right", "middle"]).optional(),
          count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        }).superRefine((value, context) => {
          if ((value.elementId === undefined) === (value.point === undefined)) {
            context.addIssue({ code: "custom", message: "click требует ровно один elementId или point" })
          }
          if (value.elementId !== undefined && (value.button !== undefined || value.count !== undefined)) {
            context.addIssue({ code: "custom", message: "AX element click не принимает pointer button/count" })
          }
        }) as z.ZodType<AgentClickInput>
    this.registry.register("click", {
      title: "Нажать element или точку снимка",
      description: this.pointer === undefined
        ? "Выполняет AXPress ранее выданного elementId; координатный fallback отсутствует."
        : "Выполняет AXPress по elementId либо pointer click по точке исходного observation.",
      input,
      output: clickResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      requiredCapabilities: this.pointer === undefined
        ? ["desktop.applications", "desktop.windows.all", "desktop.window.identity", "desktop.displays",
            "desktop.ax", "runtime.user-interference", "runtime.operations"]
        : ["desktop.displays", "capture.observation", "input.pointer", "input.readiness",
            "runtime.user-interference", "runtime.operations"],
      execute: (context, input) => {
        if (input.point !== undefined) {
          return this.pointer!.clickPoint(context.session, input.targetId, input.point, {
            ...(input.button === undefined ? {} : { button: input.button }),
            ...(input.count === undefined ? {} : { count: input.count }),
          }, context.signal)
        }
        if (input.elementId === undefined) throw new Error("click elementId отсутствует")
        return this.#click(context.session, input.targetId, input.elementId, context.signal)
      },
    })
  }

  async #click(
    session: RuntimeClientSession,
    targetId: string,
    elementId: string,
    signal: AbortSignal,
  ) {
    return clickResultSchema.parse(await this.operations.runTrackedMutation(
      session,
      targetId,
      "ax-press",
      async context => {
        const binding = await this.methods.refreshNativeAction(
          session,
          targetId,
          context.binding,
          context.signal,
        )
        if (binding.target.kind !== "window" && binding.target.kind !== "surface") {
          throw new Error("AXPress требует window или surface target")
        }
        const scope = this.targets.forLineage(this.core.clients.lineage(session))
        const element = scope.resolveElement(targetId, elementId, "AXPress")
        if (
          element.elementRef.runtimeEpoch !== binding.target.ref.runtimeEpoch
          || element.elementRef.loginSessionId !== binding.target.ref.loginSessionId
          || element.elementRef.nativeGeneration !== binding.target.ref.nativeGeneration
          || element.elementRef.applicationRef !== binding.target.ref.applicationRef
        ) {
          throw new Error("AX element не принадлежит exact parent window")
        }
        const request = { element: element.elementRef }
        const response = await this.methods.withViewAction(
          session,
          targetId,
          context.clientRequestId,
          "ui-action",
          () => this.#dispatch(session, "press_accessibility", {
            clientRequestId: context.clientRequestId,
            precondition: {
              target: binding.target,
              inventoryId: binding.inventoryId,
              inventoryRevision: binding.inventoryRevision,
            },
            request,
          }, context.signal),
        )
        const output = response.data as AxPressMethodOutput
        if (
          output.operation.context.clientRequestId !== context.clientRequestId
          || output.operation.context.inventoryId !== binding.inventoryId
          || output.operation.context.inventoryRevision !== binding.inventoryRevision
          || !structurallyEqual(output.operation.context.target, binding.target)
          || !output.result.ok
          || !axPressResultMatches(request, output.result.value)
        ) {
          throw new Error("Internal AXPress operation не совпадает с agent element binding")
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
    if (response.isError) throw new Error(`Internal runtime method ${name} failed`)
    return response
  }
}

export function registerAgentAxMethods(
  registry: MethodRegistry,
  core: RuntimeCore,
  targets: AgentTargetRegistry,
  methods: RuntimeAgentMethods,
  operations: AgentOperations = methods.operations,
  pointer?: AgentPointClickHandler,
): RuntimeAgentAxMethods {
  const ax = new RuntimeAgentAxMethods(registry, core, targets, methods, operations, pointer)
  ax.register()
  return ax
}

function projectOutcome(operation: AxPressMethodOutput["operation"]): AgentOperationOutcome {
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
