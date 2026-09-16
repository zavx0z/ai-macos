import { bindDeadline, signalDeadline } from "./deadline.ts"
import { capabilityIsReady, contractJsonSchema, parseWireValue, utf8ByteLength, z, type CapabilityId, type RuntimeClientSession } from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import { RuntimeContractError } from "./errors.ts"
import { sha256 } from "./primitives.ts"

export type RuntimeToolDescriptor = {
  name: string
  title: string
  description: string
  inputSchema: { type: "object", properties?: Record<string, unknown>, required?: string[], [key: string]: unknown }
  outputSchema: { type: "object", [key: string]: unknown }
  annotations: { readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean }
  _meta?: { maxRequestBytes: number, maxResponseBytes: number, timeoutMs?: number }
}

export type RuntimeMethodContext = {
  session: RuntimeClientSession
  signal: AbortSignal
}

export type RuntimeMethodVisibility = "public" | "internal"

export type MethodDefinition<Input, Output> = {
  title: string
  description: string
  input: z.ZodType<Input>
  output: z.ZodType<Output>
  readOnly: boolean
  destructive?: boolean
  timeoutMs?: number
  execute(context: RuntimeMethodContext, input: Input): Promise<Output>
  frames?(output: Output): readonly string[]
  requiredCapabilities?: readonly CapabilityId[]
  maxRequestBytes?: number
  maxResponseBytes?: number
  availableDuringDrain?: boolean
  visibility?: RuntimeMethodVisibility
  isError?(output: Output): boolean
}

export type RuntimeMethodResponse = {
  data: Record<string, unknown>
  frameRefs: string[]
  isError?: boolean
}

type StoredMethod = {
  descriptor: RuntimeToolDescriptor
  visibility: RuntimeMethodVisibility
  requiredCapabilities: readonly CapabilityId[]
  availableDuringDrain: boolean
  invoke(context: RuntimeMethodContext, input: unknown): Promise<RuntimeMethodResponse>
}

export type InternalMethodRegistry = Readonly<{
  descriptors(): { revision: number, tools: RuntimeToolDescriptor[] }
  dispatch(session: RuntimeClientSession, name: string, input: unknown, signal: AbortSignal): Promise<RuntimeMethodResponse>
}>

export class MethodRegistry {
  readonly #runtime: RuntimeCore
  readonly #methods = new Map<string, StoredMethod>()
  readonly #listeners = new Set<() => void>()
  readonly #settledListeners = new Set<() => void>()
  readonly internal: InternalMethodRegistry
  #revision = 0
  #internalRevision = 0
  #serializedCatalog?: Readonly<{ body: string, etag: string }>

  constructor(runtime: RuntimeCore) {
    this.#runtime = runtime
    this.internal = Object.freeze({
      descriptors: () => this.#descriptors("internal"),
      dispatch: (session, name, input, signal) => this.#dispatch(session, name, input, signal, "internal"),
    })
    runtime.subscribeCapabilities(() => this.#changed("both"))
    runtime.subscribeAdmission(() => this.#changed("both"))
  }

  register<Input, Output>(name: string, definition: MethodDefinition<Input, Output>): void {
    if (!/^[a-z][a-z0-9_]{0,126}$/.test(name) || this.#methods.has(name)) throw new Error("Duplicate/invalid method name")
    if (definition.readOnly && definition.destructive) throw new Error("Read-only method не может быть destructive")
    if (definition.visibility !== undefined && !["public", "internal"].includes(definition.visibility)) {
      throw new Error("Method visibility должна быть public или internal")
    }
    const frozen = Object.freeze({ ...definition, input: definition.input.clone(), output: definition.output.clone(),
      visibility: definition.visibility ?? "public",
      requiredCapabilities: Object.freeze([...(definition.requiredCapabilities ?? [])]) })
    const execute = frozen.execute.bind(frozen)
    const frames = frozen.frames?.bind(frozen)
    const isError = frozen.isError?.bind(frozen)
    const inputSchema = contractJsonSchema(frozen.input)
    const outputSchema = contractJsonSchema(frozen.output)
    if (inputSchema.type !== "object" || outputSchema.type !== "object") throw new Error("Method root schemas должны быть object")
    const timeoutMs = frozen.timeoutMs ?? 5000
    const maxRequestBytes = frozen.maxRequestBytes ?? 1024 * 1024
    const maxResponseBytes = frozen.maxResponseBytes ?? 1024 * 1024
    for (const limit of [maxRequestBytes, maxResponseBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 128 || limit > 8 * 1024 * 1024) throw new Error("Method serialized budget вне bounds")
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Method timeout вне bounds")
    this.#methods.set(name, {
      visibility: frozen.visibility,
      descriptor: {
        name, title: frozen.title, description: frozen.description,
        inputSchema: inputSchema as RuntimeToolDescriptor["inputSchema"],
        outputSchema: outputSchema as RuntimeToolDescriptor["outputSchema"],
        annotations: { readOnlyHint: frozen.readOnly, destructiveHint: frozen.destructive ?? false, openWorldHint: false },
        _meta: { maxRequestBytes, maxResponseBytes, timeoutMs },
      },
      requiredCapabilities: frozen.requiredCapabilities,
      availableDuringDrain: frozen.availableDuringDrain ?? false,
      invoke: async (context, raw) => {
        const input = parseWireValue(frozen.input, raw, { maxBytes: maxRequestBytes, maxDepth: 32 })
        const inherited = signalDeadline(context.signal)
        const deadlineAtMs = inherited ?? Date.now() + timeoutMs
        const controller = new AbortController()
        bindDeadline(controller.signal, deadlineAtMs)
        const onAbort = () => controller.abort(context.signal.reason)
        context.signal.addEventListener("abort", onAbort, { once: true })
        if (context.signal.aborted) onAbort()
        let timer: ReturnType<typeof setTimeout> | undefined
        let abortListener: (() => void) | undefined
        try {
          const stop = new Promise<never>((_, reject) => {
            abortListener = () => reject(new RuntimeContractError("cancelled", "Method отменён", name))
            controller.signal.addEventListener("abort", abortListener, { once: true })
            if (controller.signal.aborted) abortListener()
            if (inherited === undefined) timer = setTimeout(() => controller.abort("method deadline"), Math.max(0, deadlineAtMs - Date.now()))
          })
          if (controller.signal.aborted) throw new RuntimeContractError("cancelled", "Method отменён", name)
          const output = await Promise.race([execute({ ...context, signal: controller.signal }, input), stop])
          const validated = parseWireValue(frozen.output, output, { maxBytes: maxResponseBytes, maxDepth: 32 })
          if (validated === null || typeof validated !== "object" || Array.isArray(validated)) throw new Error("Invalid method output")
          const frameRefs = [...(frames?.(validated) ?? [])]
          if (frameRefs.length > 4 || frameRefs.some(ref => typeof ref !== "string" || ref.length > 127)) throw new Error("Invalid frame references")
          const response = { data: validated as Record<string, unknown>, frameRefs,
            ...(isError === undefined ? {} : { isError: isError(validated) }) }
          if (utf8ByteLength(response) > maxResponseBytes) throw new RuntimeContractError("payload-too-large", "Serialized method response превышает budget", name)
          return response
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          if (abortListener !== undefined) controller.signal.removeEventListener("abort", abortListener)
          context.signal.removeEventListener("abort", onAbort)
        }
      },
    })
    this.#changed(frozen.visibility)
  }

  descriptors(): { revision: number, tools: RuntimeToolDescriptor[] } {
    return this.#descriptors("public")
  }

  /** Неизменившийся каталог не копируется и не сериализуется на каждом poll. */
  serializedCatalog(): Readonly<{ body: string, etag: string }> {
    if (this.#serializedCatalog === undefined) {
      const body = JSON.stringify(this.descriptors())
      this.#serializedCatalog = Object.freeze({
        body,
        etag: `"${sha256(`${this.#runtime.generation.runtimeEpoch}\n${body}`)}"`,
      })
    }
    return this.#serializedCatalog
  }

  #descriptors(visibility: RuntimeMethodVisibility): { revision: number, tools: RuntimeToolDescriptor[] } {
    const catalog = { revision: visibility === "public" ? this.#revision : this.#internalRevision,
      tools: [...this.#methods.values()]
      .filter(method => visibility === "internal" || method.visibility === "public")
      .filter(method => !this.#runtime.admissionSealed || method.availableDuringDrain)
      .filter(method => method.requiredCapabilities.every(id => capabilityIsReady(this.#runtime.capabilities, id)))
      .map(method => structuredClone(method.descriptor)) }
    if (utf8ByteLength(catalog) > 8 * 1024 * 1024) throw new Error("Catalogue serialized budget exceeded")
    return catalog
  }

  async dispatch(session: RuntimeClientSession, name: string, input: unknown, signal: AbortSignal): Promise<RuntimeMethodResponse> {
    return this.#dispatch(session, name, input, signal, "public")
  }

  async #dispatch(
    session: RuntimeClientSession,
    name: string,
    input: unknown,
    signal: AbortSignal,
    visibility: RuntimeMethodVisibility,
  ): Promise<RuntimeMethodResponse> {
    await this.#runtime.clients.assertActive(session, new Date())
    if (signal.aborted) throw new RuntimeContractError("cancelled", "Method отменён до dispatch", "method-registry")
    const method = this.#methods.get(name)
    if (method === undefined || visibility === "public" && method.visibility === "internal") {
      throw new RuntimeContractError("unsupported-capability", "Method не зарегистрирован", "method-registry")
    }
    if (this.#runtime.admissionSealed && !method.availableDuringDrain) throw new RuntimeContractError("capability-unavailable", "Runtime admission sealed", "method-registry")
    if (!method.requiredCapabilities.every(id => capabilityIsReady(this.#runtime.capabilities, id))) throw new RuntimeContractError("capability-unavailable", "Required capabilities unavailable", "method-registry")
    try { return await method.invoke({ session, signal }, input) }
    finally {
      for (const listener of this.#settledListeners) {
        try { listener() } catch { /* Проверка lifecycle не меняет возвращаемый результат. */ }
      }
    }
  }

  subscribeCallSettled(listener: () => void): () => void {
    this.#settledListeners.add(listener)
    return () => { this.#settledListeners.delete(listener) }
  }

  subscribeCatalogChanged(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changed(visibility: RuntimeMethodVisibility | "both"): void {
    this.#internalRevision++
    if (visibility === "internal") return
    this.#revision++
    this.#serializedCatalog = undefined
    for (const listener of this.#listeners) listener()
  }
}
