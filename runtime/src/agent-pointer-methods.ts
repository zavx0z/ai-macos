import {
  OPERATION_STATES,
  dispatchStateSchema,
  structurallyEqual,
  z,
  type Observation,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import { clickActionSchema, dragActionSchema, hoverActionSchema, scrollActionSchema } from "@meta/input/actions"
import { AgentOperations, type AgentOperationOutcome } from "./agent-operations.ts"
import { agentTargetIdSchema, type RuntimeAgentMethods } from "./agent-methods.ts"
import type { InputMethodOutput } from "./input-methods.ts"
import type { MethodRegistry, RuntimeMethodResponse } from "./method-registry.ts"

const imagePointSchema = z.tuple([z.number().finite(), z.number().finite()])
export type AgentImagePoint = z.infer<typeof imagePointSchema>
export type AgentPointClickOptions = Readonly<{
  button?: z.input<typeof clickActionSchema>["button"]
  count?: z.input<typeof clickActionSchema>["count"]
}>

const actionOutcomeSchema = z.strictObject({
  state: z.enum(OPERATION_STATES),
  dispatch: dispatchStateSchema,
  cleanup: z.enum(["pending", "complete", "incomplete", "unknown"]),
  effect: z.enum(["unverified", "verified"]),
  updatedAt: z.iso.datetime({ offset: true }),
  error: z.strictObject({ code: z.string(), recoveryAction: z.string() }).optional(),
})

export const agentPointerResultSchema = z.strictObject({
  targetId: agentTargetIdSchema,
  operationId: agentTargetIdSchema,
  outcome: actionOutcomeSchema,
})
export type AgentPointerResult = z.infer<typeof agentPointerResultSchema>

export interface AgentPointClickHandler {
  clickPoint(
    session: RuntimeClientSession,
    targetId: string,
    point: AgentImagePoint,
    options: AgentPointClickOptions,
    signal: AbortSignal,
  ): Promise<AgentPointerResult>
}

/** Композирует pointer actions только из сохранённого observation и свежей native target authority. */
export class RuntimeAgentPointerMethods implements AgentPointClickHandler {
  constructor(
    private readonly registry: MethodRegistry,
    private readonly methods: RuntimeAgentMethods,
    private readonly operations: AgentOperations = methods.operations,
  ) {}

  register(): void {
    this.registry.register("hover", {
      title: "Навести на точку снимка",
      description: "Наводит указатель на точку исходного observation без recapture или rebasing.",
      input: z.strictObject({ targetId: agentTargetIdSchema, point: imagePointSchema }),
      output: agentPointerResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      requiredCapabilities: pointerCapabilities("input.pointer"),
      execute: (context, input) => this.#run(
        context.session,
        input.targetId,
        "pointer-hover",
        "mouse_move",
        hoverActionSchema.parse({ kind: "hover", point: point(input.point) }),
        context.signal,
      ),
    })

    this.registry.register("scroll", {
      title: "Прокрутить от точки снимка",
      description: "Прокручивает exact native target от точки исходного observation в явных line или pixel units.",
      input: z.strictObject({
        targetId: agentTargetIdSchema,
        anchor: imagePointSchema,
        dx: scrollActionSchema.shape.dx,
        dy: scrollActionSchema.shape.dy,
        unit: z.enum(["line", "pixel"]),
      }).refine(input => input.dx !== 0 || input.dy !== 0, {
        path: ["dy"],
        message: "scroll требует ненулевой dx или dy",
      }),
      output: agentPointerResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      requiredCapabilities: pointerCapabilities("input.pointer"),
      execute: (context, input) => this.#run(
        context.session,
        input.targetId,
        "pointer-scroll",
        "mouse_scroll",
        scrollActionSchema.parse({
          kind: "scroll",
          anchor: point(input.anchor),
          dx: input.dx,
          dy: input.dy,
          unit: input.unit,
        }),
        context.signal,
      ),
    })

    this.registry.register("drag", {
      title: "Перетащить между точками снимка",
      description: "Перетаскивает между двумя точками одного сохранённого observation без recapture или rebasing.",
      input: z.strictObject({
        targetId: agentTargetIdSchema,
        from: imagePointSchema,
        to: imagePointSchema,
        durationMs: dragActionSchema.shape.durationMs.default(300),
        button: dragActionSchema.shape.button,
        modifiers: dragActionSchema.shape.modifiers,
      }),
      output: agentPointerResultSchema,
      readOnly: false,
      destructive: true,
      timeoutMs: 10_000,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      requiredCapabilities: pointerCapabilities("input.drag"),
      execute: (context, input) => this.#run(
        context.session,
        input.targetId,
        "pointer-drag",
        "mouse_drag",
        dragActionSchema.parse({
          kind: "drag",
          points: [point(input.from), point(input.to)],
          durationMs: input.durationMs,
          button: input.button,
          modifiers: input.modifiers,
        }),
        context.signal,
      ),
    })
  }

  clickPoint(
    session: RuntimeClientSession,
    targetId: string,
    imagePoint: AgentImagePoint,
    options: AgentPointClickOptions,
    signal: AbortSignal,
  ): Promise<AgentPointerResult> {
    return this.#run(
      session,
      targetId,
      "pointer-click",
      "mouse_click",
      clickActionSchema.parse({ kind: "click", point: point(imagePoint), ...options }),
      signal,
    )
  }

  async #run(
    session: RuntimeClientSession,
    targetId: string,
    actionName: "pointer-hover" | "pointer-click" | "pointer-scroll" | "pointer-drag",
    method: "mouse_move" | "mouse_click" | "mouse_scroll" | "mouse_drag",
    action: z.infer<typeof hoverActionSchema> | z.infer<typeof clickActionSchema> | z.infer<typeof scrollActionSchema> | z.infer<typeof dragActionSchema>,
    signal: AbortSignal,
  ): Promise<AgentPointerResult> {
    return agentPointerResultSchema.parse(await this.operations.runTrackedMutation(
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
        if (!["window", "surface", "display", "desktop-layout"].includes(binding.target.kind)) {
          throw new Error("Pointer action требует exact native target")
        }
        const { observation } = await this.methods.getLatestObservation(session, targetId)
        const observationRef = reference(observation)
        const response = await this.methods.withViewAction(
          session,
          targetId,
          context.clientRequestId,
          "ui-action",
          () => this.#dispatch(session, method, {
            clientRequestId: context.clientRequestId,
            precondition: {
              target: binding.target,
              inventoryId: binding.inventoryId,
              inventoryRevision: binding.inventoryRevision,
              observationRef,
            },
            action,
          }, context.signal),
        )
        const output = response.data as InputMethodOutput
        const expectedKind = action.kind
        if (
          output.operation.context.clientRequestId !== context.clientRequestId
          || output.operation.context.inventoryId !== binding.inventoryId
          || output.operation.context.inventoryRevision !== binding.inventoryRevision
          || !structurallyEqual(output.operation.context.target, binding.target)
          || !structurallyEqual(output.operation.context.observationRef, observationRef)
          || !output.result.ok
          || output.result.value.kind !== expectedKind
        ) {
          throw new Error("Internal pointer operation не совпадает с agent observation/target binding")
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

export function registerAgentPointerMethods(
  registry: MethodRegistry,
  methods: RuntimeAgentMethods,
  operations: AgentOperations = methods.operations,
): RuntimeAgentPointerMethods {
  const pointer = new RuntimeAgentPointerMethods(registry, methods, operations)
  pointer.register()
  return pointer
}

function point(value: AgentImagePoint) {
  return { x: value[0], y: value[1] }
}

function reference(observation: Observation) {
  if (observation.captureEvidence.state !== "confirmed") {
    throw new Error("Pointer action требует confirmed capture evidence")
  }
  return {
    observationId: observation.observationId,
    inventoryRevision: observation.inventoryRevision,
    displayLayoutRevision: observation.displayLayoutRevision,
    proofRef: observation.captureEvidence.proof.proofRef,
  }
}

function pointerCapabilities(kind: "input.pointer" | "input.drag") {
  return [
    "desktop.displays",
    "capture.observation",
    kind,
    "input.readiness",
    "runtime.user-interference",
    "runtime.operations",
  ] as const
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
