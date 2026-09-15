import { z, type CapabilitySet } from "@meta/shared/contracts"
import {
  nativeStartupPermissionsRequestSchema,
  nativeStartupPermissionsResponseSchema,
  nativeStartupPermissionsResponseMatches,
  type NativeStartupPermissionsRequest,
  type NativeStartupPermissionsResponse,
} from "@meta/native/protocol"

export const STARTUP_PERMISSION_NAMES = ["accessibility", "screenRecording", "postEvents", "inputMonitoring"] as const
export type StartupPermissionName = typeof STARTUP_PERMISSION_NAMES[number]
export const startupPermissionsStateSchema = z.strictObject({
  state: z.enum(["not-required", "checking", "requesting", "waiting", "ready", "restart-needed", "timed-out", "failed"]),
  required: z.array(z.enum(STARTUP_PERMISSION_NAMES)).length(STARTUP_PERMISSION_NAMES.length),
  missing: z.array(z.enum(STARTUP_PERMISSION_NAMES)).max(STARTUP_PERMISSION_NAMES.length),
  requestIssued: z.boolean(),
  requestsFinished: z.boolean(),
  restartNeeded: z.boolean(),
  restartState: z.enum(["not-required", "required", "unknown"]),
  requestedAt: z.iso.datetime({ offset: true }).optional(),
  deadlineAt: z.iso.datetime({ offset: true }).optional(),
  lastCheckedAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().min(1).max(2048).optional(),
})
export type StartupPermissionsState = z.infer<typeof startupPermissionsStateSchema>

export type StartupPermissionsNative = {
  generation?: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string }
  loadedBuildId: string
  startupPermissionsRequest(
    request: NativeStartupPermissionsRequest,
    control: { signal: AbortSignal, checkpoint(): void },
  ): Promise<NativeStartupPermissionsResponse>
}

/** Вызывает official request API один раз; дальнейшие проверки строго пассивны. */
export class RuntimeStartupPermissions {
  readonly #native: StartupPermissionsNative
  readonly #now: () => Date
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #waitMs: number
  readonly #pollMs: number
  readonly #onCapabilities: (capabilities: CapabilitySet) => void
  readonly #onReady: () => void | Promise<void>
  readonly #onBlocked: (state: StartupPermissionsState) => void | Promise<void>
  readonly #verifyOwner: (signal: AbortSignal) => Promise<void>
  #state: StartupPermissionsState
  #started?: Promise<StartupPermissionsState>
  #requestIssued = false
  #readyNotified = false
  #ownerVerified = false

  constructor(options: {
    native: StartupPermissionsNative
    waitMs?: number
    pollMs?: number
    now?: () => Date
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    onCapabilities?(capabilities: CapabilitySet): void
    onReady?(): void | Promise<void>
    onBlocked?(state: StartupPermissionsState): void | Promise<void>
    verifyOwner?(signal: AbortSignal): Promise<void>
  }) {
    this.#native = options.native
    this.#waitMs = bounded(options.waitMs ?? 600_000, 1000, 600_000, "permission wait")
    this.#pollMs = bounded(options.pollMs ?? 500, 100, 5000, "permission poll")
    this.#now = options.now ?? (() => new Date())
    this.#sleep = options.sleep ?? sleep
    this.#onCapabilities = options.onCapabilities ?? (() => undefined)
    this.#onReady = options.onReady ?? (() => undefined)
    this.#onBlocked = options.onBlocked ?? (() => undefined)
    this.#verifyOwner = options.verifyOwner ?? (async () => undefined)
    this.#state = state("checking", false, false, "not-required", [])
  }

  snapshot(): StartupPermissionsState { return structuredClone(this.#state) }

  start(signal: AbortSignal): Promise<StartupPermissionsState> {
    return this.#started ??= this.#run(signal)
  }

  async refreshStatus(signal: AbortSignal): Promise<StartupPermissionsState> {
    if (this.#state.state === "ready") return this.snapshot()
    try {
      if (!this.#ownerVerified) {
        await this.#verifyOwner(signal)
        this.#ownerVerified = true
      }
      const response = await this.#status(signal)
      const fallback = ["ready", "timed-out"].includes(this.#state.state) ? "waiting" : this.#state.state
      await this.#accept(response, fallback)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw error
    }
    return this.snapshot()
  }

  async #run(signal: AbortSignal): Promise<StartupPermissionsState> {
    const deadlineAt = new Date(this.#now().getTime() + this.#waitMs).toISOString()
    this.#state = startupPermissionsStateSchema.parse({ ...this.#state, state: "checking", deadlineAt })
    try {
      await this.#verifyOwner(signal)
      this.#ownerVerified = true
      signal.throwIfAborted()
      let response = await this.#status(signal)
      await this.#accept(response, "checking")
      if (["ready", "restart-needed", "failed"].includes(this.#state.state)) return this.snapshot()
      this.#requestIssued = true
      const requestedAt = this.#now().toISOString()
      this.#state = startupPermissionsStateSchema.parse({ ...this.#state, state: "requesting", requestIssued: true, requestedAt })
      response = await this.#exchange("request-missing", signal)
      await this.#accept(response, "waiting")
      while (!["ready", "restart-needed", "failed"].includes(this.#state.state)) {
        signal.throwIfAborted()
        const remaining = Date.parse(deadlineAt) - this.#now().getTime()
        if (remaining <= 0) {
          this.#state = startupPermissionsStateSchema.parse({ ...this.#state, state: "timed-out",
            reason: this.#state.reason ?? "Не все разрешения выданы за bounded startup interval" })
          break
        }
        await this.#sleep(Math.min(this.#pollMs, remaining), signal)
        response = await this.#status(signal)
        await this.#accept(response, "waiting")
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      this.#state = startupPermissionsStateSchema.parse({ ...this.#state, state: "failed", requestIssued: this.#requestIssued,
        reason: message(error, "Startup permission flow завершился ошибкой") })
    }
    return this.snapshot()
  }

  #status(signal: AbortSignal): Promise<NativeStartupPermissionsResponse> {
    return this.#exchange("status", signal)
  }

  async #exchange(command: "request-missing" | "status", signal: AbortSignal): Promise<NativeStartupPermissionsResponse> {
    signal.throwIfAborted()
    const generation = this.#native.generation
    if (generation === undefined) throw new Error("Native permission generation недоступна")
    const request = nativeStartupPermissionsRequestSchema.parse({ kind: "permissions-request", command, protocolVersion: "1",
      requestId: `permissions-${command}:${crypto.randomUUID()}`, ...generation,
      deadlineAt: new Date(this.#now().getTime() + 2000).toISOString() })
    const response = nativeStartupPermissionsResponseSchema.parse(
      await this.#native.startupPermissionsRequest(request, { signal, checkpoint() { signal.throwIfAborted() } }),
    )
    if (!nativeStartupPermissionsResponseMatches(request, response, this.#native.loadedBuildId)) throw new Error("Native startup permission status identity mismatch")
    return response
  }

  async #accept(response: NativeStartupPermissionsResponse, fallback: StartupPermissionsState["state"]): Promise<void> {
    if (this.#state.lastCheckedAt !== undefined && Date.parse(response.observedAt) < Date.parse(this.#state.lastCheckedAt)) return
    if (this.#state.state === "ready" && !response.allGranted) return
    if (this.#state.state === "restart-needed" && !response.allGranted && response.restartState !== "required") return
    this.#onCapabilities(response.capabilities)
    const missing = STARTUP_PERMISSION_NAMES.filter(name => !response.permissions[name].currentGranted)
    const reasons = STARTUP_PERMISSION_NAMES.flatMap(name => {
      const value = response.permissions[name]
      return value.error === undefined && value.restartReason === undefined ? [] : [`${name}: ${value.error ?? value.restartReason}`]
    })
    const impossible = STARTUP_PERMISSION_NAMES.some(name => !response.permissions[name].currentGranted
      && ["unsupported", "failed"].includes(response.permissions[name].requestState))
    const nextState = response.allGranted ? "ready"
      : response.restartState === "required" ? "restart-needed"
        : impossible ? "failed" : fallback
    const { reason: _previousReason, ...previous } = this.#state
    this.#state = startupPermissionsStateSchema.parse({ ...previous, state: nextState, missing,
      requestIssued: this.#requestIssued, requestsFinished: response.requestsFinished,
      restartNeeded: response.restartNeeded, restartState: response.restartState, lastCheckedAt: response.observedAt,
      ...(reasons.length === 0 ? {} : { reason: reasons.join("; ").slice(0, 2048) }) })
    if (nextState === "ready" && !this.#readyNotified) {
      this.#readyNotified = true
      await this.#onReady()
    } else if (nextState !== "ready") {
      this.#readyNotified = false
      await this.#onBlocked(this.snapshot())
    }
  }
}

export function notRequiredStartupPermissions(): StartupPermissionsState {
  return state("not-required", false, true, "not-required", [])
}

function state(current: StartupPermissionsState["state"], requestIssued: boolean, requestsFinished: boolean,
  restartState: StartupPermissionsState["restartState"], missing: StartupPermissionName[]): StartupPermissionsState {
  return { state: current, required: [...STARTUP_PERMISSION_NAMES], missing, requestIssued, requestsFinished,
    restartNeeded: restartState === "required", restartState }
}
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} вне bounds`)
  return value
}
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
    function done() { signal.removeEventListener("abort", abort); resolve() }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
function message(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, 2048) || fallback
}
