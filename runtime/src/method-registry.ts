import { capabilityIsReady, contractJsonSchema, parseWireValue, utf8ByteLength, z, type CapabilityId, type RuntimeClientSession } from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import { RuntimeContractError } from "./errors.ts"

export type RuntimeToolDescriptor = {
  name: string
  title: string
  description: string
  inputSchema: { type: "object", properties?: Record<string, unknown>, required?: string[], [key: string]: unknown }
  outputSchema: { type: "object", [key: string]: unknown }
  annotations: { readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean }
  _meta?: { maxRequestBytes: number, maxResponseBytes: number }
}

export type RuntimeMethodContext = {
  session: RuntimeClientSession
  signal: AbortSignal
}

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
  isError?(output: Output): boolean
}

export type RuntimeMethodResponse = {
  data: Record<string, unknown>
  frameRefs: string[]
  isError?: boolean
}

type StoredMethod = {
  descriptor: RuntimeToolDescriptor
  requiredCapabilities: readonly CapabilityId[]
  availableDuringDrain: boolean
  invoke(context: RuntimeMethodContext, input: unknown): Promise<RuntimeMethodResponse>
}

export class MethodRegistry {
  readonly #runtime: RuntimeCore
  readonly #methods = new Map<string, StoredMethod>()
  readonly #listeners = new Set<() => void>()
  #revision = 0

  constructor(runtime: RuntimeCore) {
    this.#runtime = runtime
    runtime.subscribeCapabilities(() => this.#changed())
    runtime.subscribeAdmission(() => this.#changed())
  }

  register<Input, Output>(name: string, definition: MethodDefinition<Input, Output>): void {
    if (!/^[a-z][a-z0-9_]{0,126}$/.test(name) || this.#methods.has(name)) throw new Error("Duplicate/invalid method name")
    if (definition.readOnly && definition.destructive) throw new Error("Read-only method не может быть destructive")
    const frozen = Object.freeze({ ...definition, input: definition.input.clone(), output: definition.output.clone(),
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
      descriptor: {
        name, title: frozen.title, description: frozen.description,
        inputSchema: inputSchema as RuntimeToolDescriptor["inputSchema"],
        outputSchema: outputSchema as RuntimeToolDescriptor["outputSchema"],
        annotations: { readOnlyHint: frozen.readOnly, destructiveHint: frozen.destructive ?? false, openWorldHint: false },
        _meta: { maxRequestBytes, maxResponseBytes },
      },
      requiredCapabilities: frozen.requiredCapabilities,
      availableDuringDrain: frozen.availableDuringDrain ?? false,
      invoke: async (context, raw) => {
        const input = parseWireValue(frozen.input, raw, { maxBytes: maxRequestBytes, maxDepth: 32 })
        const controller = new AbortController()
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
            timer = setTimeout(() => controller.abort("method deadline"), timeoutMs)
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
    this.#changed()
  }

  descriptors(): { revision: number, tools: RuntimeToolDescriptor[] } {
    const catalog = { revision: this.#revision, tools: [...this.#methods.values()]
      .filter(method => !this.#runtime.admissionSealed || method.availableDuringDrain)
      .filter(method => method.requiredCapabilities.every(id => capabilityIsReady(this.#runtime.capabilities, id)))
      .map(method => structuredClone(method.descriptor)) }
    if (utf8ByteLength(catalog) > 8 * 1024 * 1024) throw new Error("Catalogue serialized budget exceeded")
    return catalog
  }

  async dispatch(session: RuntimeClientSession, name: string, input: unknown, signal: AbortSignal): Promise<RuntimeMethodResponse> {
    await this.#runtime.clients.assertActive(session, new Date())
    if (signal.aborted) throw new RuntimeContractError("cancelled", "Method отменён до dispatch", "method-registry")
    const method = this.#methods.get(name)
    if (method === undefined) throw new RuntimeContractError("unsupported-capability", "Method не зарегистрирован", "method-registry")
    if (this.#runtime.admissionSealed && !method.availableDuringDrain) throw new RuntimeContractError("capability-unavailable", "Runtime admission sealed", "method-registry")
    if (!method.requiredCapabilities.every(id => capabilityIsReady(this.#runtime.capabilities, id))) throw new RuntimeContractError("capability-unavailable", "Required capabilities unavailable", "method-registry")
    return method.invoke({ session, signal }, input)
  }

  subscribeCatalogChanged(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changed(): void {
    this.#revision++
    for (const listener of this.#listeners) listener()
  }
}
