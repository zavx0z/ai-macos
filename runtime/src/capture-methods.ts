import { operationDeadline } from "./deadline.ts"
import {
  adapterResultSchema,
  captureClipSchema,
  captureOutputPolicySchema,
  capturePolicySha256,
  desktopLayoutCaptureTargetSchema,
  displayCaptureTargetSchema,
  observationSchema,
  opaqueIdSchema,
  operationRecordSchema,
  readinessPolicySchema,
  runtimeOperationIntentSchema,
  screenCaptureRequestSchema,
  screenCaptureResultSchema,
  windowCaptureTargetSchema,
  z,
  type Observation,
  type RuntimeClientSession,
  type ScreenAdapter,
  type ScreenCaptureRequest,
  type ScreenCaptureResult,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry } from "./method-registry.ts"

type CaptureRuntime = Pick<
  RuntimeCore,
  | "generation"
  | "clients"
  | "reserveCapturePublication"
  | "commitCaptureObservation"
  | "getObservation"
  | "getOperationByRequest"
  | "frames"
  | "runOperation"
>

const captureInputCommon = {
  clientRequestId: opaqueIdSchema,
  inventoryId: opaqueIdSchema,
  caption: z.string().min(1).max(2_048),
  clip: captureClipSchema,
  cursor: z.enum(["include", "exclude"]),
  readinessPolicy: readinessPolicySchema,
  output: captureOutputPolicySchema,
}

export const captureDesktopMethodInputSchema = z.strictObject({
  ...captureInputCommon,
  target: z.union([displayCaptureTargetSchema, desktopLayoutCaptureTargetSchema]),
})

export const captureWindowMethodInputSchema = z.strictObject({
  ...captureInputCommon,
  target: windowCaptureTargetSchema,
})

export const captureExecutionSchema = z.strictObject({
  operation: operationRecordSchema,
  result: adapterResultSchema(screenCaptureResultSchema),
  frameAvailable: z.boolean(),
})

export const getObservationMethodInputSchema = z.strictObject({
  observationId: opaqueIdSchema,
})

export const getObservationMethodOutputSchema = z.strictObject({
  observation: observationSchema.nullable(),
  frameAvailable: z.boolean(),
})

export const latestCaptureMethodInputSchema = z.strictObject({
  after: z.number().int().safe().min(0).optional(),
})

export const latestCaptureMethodOutputSchema = z.strictObject({
  changed: z.boolean(),
  version: z.number().int().safe().min(0),
  observation: observationSchema.optional(),
  frameAvailable: z.boolean(),
})

type CaptureMethodInput = z.infer<typeof captureDesktopMethodInputSchema>
  | z.infer<typeof captureWindowMethodInputSchema>

type LatestState = {
  observationId: string
  version: number
}

export class RuntimeCaptureMethods {
  readonly #runtime: CaptureRuntime
  readonly #screen: ScreenAdapter
  readonly #latest = new Map<string, LatestState>()

  constructor(runtime: CaptureRuntime, screen: ScreenAdapter) {
    this.#runtime = runtime
    this.#screen = screen
  }

  register(registry: MethodRegistry): void {
    registry.register("capture_desktop", {
      title: "Снимок рабочего стола",
      description: "Захватывает exact display или desktop layout без focus/raise и возвращает runtime-owned observation.",
      input: captureDesktopMethodInputSchema,
      output: captureExecutionSchema,
      readOnly: true,
      timeoutMs: 15_000,
      requiredCapabilities: ["capture.desktop", "capture.observation", "runtime.operations"],
      isError: output => !output.result.ok,
      frames: captureFrameRefs,
      execute: (context, input) => this.#capture(context.session, "display-composite", input, context.signal),
    })
    registry.register("capture_window", {
      title: "Изолированный снимок окна",
      description: "Захватывает exact CG/AX-correlated window без activation и исключает auxiliary surfaces.",
      input: captureWindowMethodInputSchema,
      output: captureExecutionSchema,
      readOnly: true,
      timeoutMs: 15_000,
      requiredCapabilities: ["capture.window", "capture.observation", "runtime.operations"],
      isError: output => !output.result.ok,
      frames: captureFrameRefs,
      execute: (context, input) => this.#capture(context.session, "window-isolated", input, context.signal),
    })
    registry.register("get_observation", {
      title: "Наблюдение по ID",
      description: "Возвращает observation только текущей authenticated client lineage.",
      input: getObservationMethodInputSchema,
      output: getObservationMethodOutputSchema,
      readOnly: true,
      requiredCapabilities: ["capture.observation"],
      frames: observationOutputFrameRefs,
      execute: async (context, input) => {
        const observation = await this.#runtime.getObservation(context.session, input.observationId) ?? null
        const frameAvailable = observation !== null && this.#runtime.frames.get(
          observation.image.frameRef,
          this.#runtime.clients.lineage(context.session),
        ) !== undefined
        return { observation, frameAvailable }
      },
    })
    registry.register("latest_capture", {
      title: "Последний снимок",
      description: "Возвращает последнее committed observation текущей client lineage и только изменившийся frame.",
      input: latestCaptureMethodInputSchema,
      output: latestCaptureMethodOutputSchema,
      readOnly: true,
      requiredCapabilities: ["capture.observation"],
      frames: latestOutputFrameRefs,
      execute: (context, input) => this.#latestCapture(context.session, input.after),
    })
  }

  async #capture(
    session: RuntimeClientSession,
    source: ScreenCaptureRequest["source"],
    input: CaptureMethodInput,
    signal: AbortSignal,
  ): Promise<z.infer<typeof captureExecutionSchema>> {
    if (signal.aborted) throw new DOMException("Capture method aborted", "AbortError")
    const policy = {
      clip: input.clip,
      fullPage: false as const,
      cursor: input.cursor,
      readinessPolicy: input.readinessPolicy,
      output: input.output,
    }
    const proof = input.target.mappingEvidence.state === "confirmed"
      ? input.target.mappingEvidence.proof
      : undefined
    if (proof === undefined) throw new Error("Capture target не содержит confirmed mapping proof")
    const existingOperation = await this.#runtime.getOperationByRequest(session, input.clientRequestId)
    const publication = await this.#runtime.reserveCapturePublication(session, {
      clientRequestId: input.clientRequestId,
      source,
      captureTarget: input.target.target,
      capturePolicySha256: capturePolicySha256(policy),
      inventoryId: input.inventoryId,
      inventoryRevision: proof.inventoryRevision,
      displayLayoutRevision: proof.displayLayoutRevision,
      nativeGeneration: input.target.target.ref.nativeGeneration,
      ttlMs: 120_000,
    })
    const request = screenCaptureRequestSchema.parse({
      source,
      caption: input.caption,
      publication,
      target: input.target,
      ...policy,
    })
    const deadlineAt = operationDeadline(signal, 12_000)
    const intent = runtimeOperationIntentSchema.parse({
      intent: "read",
      clientRequestId: input.clientRequestId,
      precondition: {
        target: request.target.target,
        inventoryId: publication.inventoryId,
        inventoryRevision: publication.inventoryRevision,
      },
      deadlineAt,
      requestedResources: [{ kind: "capture-stream", resourceRef: publication.observationId }],
    })
    const execution = await this.#runtime.runOperation(
      session,
      intent,
      request,
      async (context, value) => {
        if (context.wire.kind !== "native") throw new Error("Screen capture требует native execution context")
        return await this.#screen.capture({ ...context, wire: context.wire }, value)
      },
      signal,
    )
    if (execution.result.ok) {
      const historical = existingOperation !== undefined
        && existingOperation.context.operationId === execution.operation.context.operationId
        && existingOperation.state === "completed"
      let observation: Observation | undefined
      if (historical) {
        observation = await this.#runtime.getObservation(session, publication.observationId).catch(() => undefined)
      }
      if (observation === undefined) {
        try {
          observation = await this.#runtime.commitCaptureObservation(
            session,
            publication,
            execution.result.value.observation,
          )
        } catch (error) {
          if (!historical) throw error
        }
      }
      if (observation !== undefined) this.#remember(session, observation)
    }
    const frameAvailable = execution.result.ok && this.#runtime.frames.get(
      execution.result.value.frame.frameRef,
      this.#runtime.clients.lineage(session),
    ) !== undefined
    return captureExecutionSchema.parse({ ...execution, frameAvailable })
  }

  async #latestCapture(
    session: RuntimeClientSession,
    after: number | undefined,
  ): Promise<z.infer<typeof latestCaptureMethodOutputSchema>> {
    const observation = await this.#runtime.getObservation(session)
    if (observation === undefined) return { changed: false, version: 0, frameAvailable: false }
    const lineage = this.#runtime.clients.lineage(session)
    let latest = this.#latest.get(lineage)
    if (latest?.observationId !== observation.observationId) {
      latest = { observationId: observation.observationId, version: (latest?.version ?? 0) + 1 }
      this.#latest.set(lineage, latest)
    }
    const changed = after === undefined || after !== latest.version
    const frameAvailable = this.#runtime.frames.get(
      observation.image.frameRef,
      lineage,
    ) !== undefined
    return {
      changed,
      version: latest.version,
      frameAvailable,
      ...(changed ? { observation } : {}),
    }
  }

  #remember(session: RuntimeClientSession, observation: Observation): void {
    const lineage = this.#runtime.clients.lineage(session)
    const current = this.#latest.get(lineage)
    if (current?.observationId === observation.observationId) return
    this.#latest.set(lineage, {
      observationId: observation.observationId,
      version: (current?.version ?? 0) + 1,
    })
  }
}

export function registerCaptureMethods(
  registry: MethodRegistry,
  runtime: CaptureRuntime,
  screen: ScreenAdapter,
): RuntimeCaptureMethods {
  const methods = new RuntimeCaptureMethods(runtime, screen)
  methods.register(registry)
  return methods
}

function captureFrameRefs(output: z.infer<typeof captureExecutionSchema>): string[] {
  return output.result.ok && output.frameAvailable ? [output.result.value.frame.frameRef] : []
}

function observationOutputFrameRefs(output: z.infer<typeof getObservationMethodOutputSchema>): string[] {
  return output.observation === null || !output.frameAvailable ? [] : [output.observation.image.frameRef]
}

function latestOutputFrameRefs(output: z.infer<typeof latestCaptureMethodOutputSchema>): string[] {
  return output.changed && output.frameAvailable && output.observation !== undefined
    ? [output.observation.image.frameRef]
    : []
}
