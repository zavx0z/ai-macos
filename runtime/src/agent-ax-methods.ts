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

/** Регистрирует только semantic AXPress по snapshot-bound elementId. */
export class RuntimeAgentAxMethods {
  constructor(
    private readonly registry: MethodRegistry,
    private readonly core: RuntimeCore,
    private readonly targets: AgentTargetRegistry,
    private readonly methods: RuntimeAgentMethods,
    private readonly operations: AgentOperations = methods.operations,
  ) {}

  register(): void {
    this.registry.register("click", {
      title: "Нажать AX element",
      description: "Выполняет AXPress ранее выданного elementId; координатный fallback отсутствует.",
      input: z.strictObject({ targetId: agentTargetIdSchema, elementId: agentTargetIdSchema }),
      output: clickResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      requiredCapabilities: [
        "desktop.applications",
        "desktop.windows.all",
        "desktop.window.identity",
        "desktop.displays",
        "desktop.ax",
        "runtime.operations",
      ],
      execute: (context, input) => this.#click(
        context.session,
        input.targetId,
        input.elementId,
        context.signal,
      ),
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
        const binding = await this.methods.refreshWindowAction(
          session,
          targetId,
          context.binding,
          context.signal,
        )
        if (binding.target.kind !== "window") throw new Error("AXPress требует window target")
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
        const response = await this.#dispatch(session, "press_accessibility", {
          clientRequestId: context.clientRequestId,
          precondition: {
            target: binding.target,
            inventoryId: binding.inventoryId,
            inventoryRevision: binding.inventoryRevision,
          },
          request,
        }, context.signal)
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
    const response = await this.registry.dispatch(session, name, input, signal)
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
): RuntimeAgentAxMethods {
  const ax = new RuntimeAgentAxMethods(registry, core, targets, methods, operations)
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
