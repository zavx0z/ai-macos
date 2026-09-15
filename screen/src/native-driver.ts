import {
  NativeCaptureClient,
  type NativeCaptureTask as ProtocolCaptureTask,
} from "@meta/native/capture-client"
import {
  READINESS_STEP_NAMES,
  type ReadinessStepName,
} from "@meta/shared/contracts"
import {
  type NativeCaptureCompletion,
  type NativeCaptureDriver,
  type NativeCaptureDriverRequest,
  type NativeCaptureFailure,
  type NativeCaptureReadinessFact,
  type NativeCaptureSuccess,
  type NativeCaptureTask,
  type NativeCaptureTaskStatus,
} from "./adapter.ts"

type TrackedTask = {
  protocol: ProtocolCaptureTask
  result: Promise<NativeCaptureCompletion>
}

type ReleasedTask = {
  idempotencyKey: string
}

export class ProtocolNativeCaptureDriver implements NativeCaptureDriver {
  readonly #client: NativeCaptureClient
  readonly #tasks = new Map<string, TrackedTask>()
  readonly #releaseKeys = new Map<string, string>()
  readonly #released = new Map<string, ReleasedTask>()
  readonly #pollIntervalMs: number

  constructor(client: NativeCaptureClient, pollIntervalMs = 10) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 1_000) {
      throw new Error("Native capture poll interval должен быть в диапазоне 0..1000 ms")
    }
    this.#client = client
    this.#pollIntervalMs = pollIntervalMs
  }

  async start(
    context: Parameters<NativeCaptureDriver["start"]>[0],
    input: NativeCaptureDriverRequest,
  ): Promise<NativeCaptureTask> {
    const protocol = await this.#client.start(
      context,
      input.request,
      input.nativeMapping,
      {
        captureTimeoutMs: input.captureTimeoutMs,
        stopTimeoutMs: input.stopTimeoutMs,
      },
    )
    if (this.#tasks.has(protocol.taskRef) || this.#released.has(protocol.taskRef)) {
      throw new Error(`Native protocol повторно выдал captureTaskRef ${protocol.taskRef}`)
    }
    const result = this.#pollUntilTerminal(
      protocol,
      Date.parse(context.wire.deadlineAt) + input.stopTimeoutMs,
    )
    this.#tasks.set(protocol.taskRef, { protocol, result })
    return { taskRef: protocol.taskRef, result }
  }

  async cancel(taskRef: string, reason: string): Promise<void> {
    await this.#task(taskRef).protocol.cancel(reason)
  }

  async status(taskRef: string): Promise<NativeCaptureTaskStatus> {
    return mapStatus(await this.#task(taskRef).protocol.status())
  }

  async release(
    taskRef: string,
    idempotencyKey: string,
  ): Promise<{ taskRef: string, status: "released" | "already-released" }> {
    const released = this.#released.get(taskRef)
    if (released !== undefined) {
      if (released.idempotencyKey !== idempotencyKey) {
        throw new Error("Native capture release idempotency key конфликтует с tombstone")
      }
      return { taskRef, status: "already-released" }
    }
    const previousKey = this.#releaseKeys.get(taskRef)
    if (previousKey !== undefined && previousKey !== idempotencyKey) {
      throw new Error("Native capture release retry использует другой idempotency key")
    }
    this.#releaseKeys.set(taskRef, idempotencyKey)
    const tracked = this.#task(taskRef)
    await tracked.protocol.release()
    this.#tasks.delete(taskRef)
    this.#releaseKeys.delete(taskRef)
    this.#released.set(taskRef, { idempotencyKey })
    return { taskRef, status: "released" }
  }

  async #pollUntilTerminal(
    task: ProtocolCaptureTask,
    deadlineMs: number,
  ): Promise<NativeCaptureCompletion> {
    while (Date.now() < deadlineMs) {
      const result = await task.result()
      if (result.poll.state === "completed") return mapCompletion(result)
      if (this.#pollIntervalMs > 0) await Bun.sleep(this.#pollIntervalMs)
    }
    throw new Error("Native capture result polling превысил operation + stop budget")
  }

  #task(taskRef: string): TrackedTask {
    const task = this.#tasks.get(taskRef)
    if (task === undefined) throw new Error(`Native capture task не найден: ${taskRef}`)
    return task
  }
}

function mapCompletion(
  value: Awaited<ReturnType<ProtocolCaptureTask["result"]>>,
): NativeCaptureCompletion {
  if (value.poll.state !== "completed") throw new Error("Native capture poll ещё не terminal")
  const completion = value.poll.result
  const common = {
    taskRef: completion.captureTaskRef,
    cleanup: completion.cleanup,
    drained: value.poll.status.drained,
    statusRevision: value.poll.status.revision,
  }
  if (completion.outcome !== "succeeded") {
    if (completion.errorCode === "none") throw new Error("Native capture failure потерял errorCode")
    return {
      ...common,
      ok: false,
      code: completion.errorCode,
      message: completion.errorMessage ?? `Native capture завершился ${completion.outcome}`,
    } satisfies NativeCaptureFailure
  }
  if (completion.frame === undefined || value.bytes === undefined || value.evidenceReceipt === undefined) {
    throw new Error("Native capture success не содержит frame bytes/evidence receipt")
  }
  const readinessFacts = readinessFactRecord(completion.readinessFacts)
  return {
    ...common,
    ok: true,
    source: completion.source,
    caption: completion.caption,
    target: completion.target,
    nativeMapping: completion.nativeMapping,
    clip: completion.clip,
    cursor: completion.cursor,
    scale: completion.scale,
    widthPx: completion.frame.widthPx,
    heightPx: completion.frame.heightPx,
    encodedBytes: completion.frame.encodedBytes,
    capturedAt: completion.frame.capturedAt,
    frameStatus: completion.frame.frameStatus,
    backend: completion.backend,
    evidenceReceipt: value.evidenceReceipt,
    targetEvidence: completion.targetEvidence,
    readinessFacts,
    occlusion: {
      state: "unknown",
      claim: "pixel-occlusion",
      source: "native-capture-protocol",
      reason: "Native frame metadata не является runtime pixel ownership proof",
    },
    regions: completion.frame.regions.map(region => ({
      nativeDisplayId: region.nativeDisplayId,
      frameOrientation: region.frameOrientation,
      imageRect: region.imageRect,
      destinationRect: region.destinationRect,
      imageToDestination: region.imageToDestination,
      frameTimestamp: region.frameTimestamp,
      frameStatus: "complete",
    })),
    bytes: value.bytes,
  } satisfies NativeCaptureSuccess
}

function readinessFactRecord(
  values: Array<{
    name: string
    state: NativeCaptureReadinessFact["state"]
    durationMs: number
    reason?: string
  }>,
): Partial<Record<ReadinessStepName, NativeCaptureReadinessFact>> {
  const result: Partial<Record<ReadinessStepName, NativeCaptureReadinessFact>> = {}
  for (const value of values) {
    if (!READINESS_STEP_NAMES.includes(value.name as ReadinessStepName)) {
      throw new Error(`Native capture вернул неизвестный readiness fact ${value.name}`)
    }
    const name = value.name as ReadinessStepName
    if (result[name] !== undefined) throw new Error(`Native capture повторил readiness fact ${name}`)
    result[name] = {
      state: value.state,
      durationMs: value.durationMs,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    }
  }
  return result
}

function mapStatus(status: Awaited<ReturnType<ProtocolCaptureTask["status"]>>): NativeCaptureTaskStatus {
  return {
    taskRef: status.captureTaskRef,
    revision: status.revision,
    cleanup: status.cleanup,
    drained: status.drained,
  }
}
