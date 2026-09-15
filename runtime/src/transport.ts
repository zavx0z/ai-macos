import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  parseWireJson,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  z,
  type AdapterResult,
  type OperationRecord,
  type RuntimeExecution,
  type RuntimeOperationContext,
  type RuntimeOperationIntent,
} from "@meta/shared/contracts"
import { RuntimeCore } from "./core.ts"
import { RuntimeContractError, contractErrorFrom } from "./errors.ts"
import { randomIdSource, type RuntimeIdSource } from "./primitives.ts"
import { MethodRegistry, type RuntimeMethodResponse, type RuntimeToolDescriptor } from "./method-registry.ts"

const MAX_RUNTIME_REQUEST_BYTES = 1024 * 1024
const MAX_RUNTIME_RESPONSE_BYTES = 8 * 1024 * 1024
const RUNTIME_TRANSPORT_TIMEOUT_MS = 5_000

export class RuntimeUnknownDeliveryError extends Error {
  constructor(
    message: string,
    readonly operation?: OperationRecord,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RuntimeUnknownDeliveryError"
  }
}

export type RuntimeToolResult = {
  content: Array<{ type: "text", text: string } | { type: "image", mimeType: "image/png", data: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

class RuntimeUdsHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Runtime UDS ${status}: ${JSON.stringify(body)}`)
  }
}

export type RuntimeMethodDefinition<Input, Result> = {
  input: z.ZodType<Input>
  execute(context: RuntimeOperationContext, input: Input): Promise<AdapterResult<Result>>
}

type StoredMethod = RuntimeMethodDefinition<unknown, unknown>

const adminInspectionSchema = z.strictObject({
  running: z.literal(true), runtimeEpoch: z.string().min(1).max(64), runtimeBuildId: z.string().min(1).max(127),
  nativeBuildId: z.string().min(1).max(127).optional(),
  activeOperations: z.number().int().min(0), quarantinedResources: z.number().int().min(0),
})
const adminDrainRequestSchema = z.strictObject({
  runtimeEpoch: z.string().min(1).max(64), buildId: z.string().min(1).max(127),
  nativeBuildId: z.string().min(1).max(127).optional(),
})
const adminDrainReceiptSchema = z.strictObject({
  runtimeEpoch: z.string().min(1).max(64), runtimeBuildId: z.string().min(1).max(127), nativeBuildId: z.string().min(1).max(127),
  cleanup: z.literal("complete"), activeOperations: z.literal(0), quarantinedResources: z.literal(0),
})
export type RuntimeAdminInspection = z.infer<typeof adminInspectionSchema>
export type RuntimeAdminDrainRequest = z.infer<typeof adminDrainRequestSchema>
export type RuntimeAdminDrainReceipt = z.infer<typeof adminDrainReceiptSchema>
export type RuntimeAdminBinding = {
  inspect(): RuntimeAdminInspection
  drain(expected: RuntimeAdminDrainRequest, signal: AbortSignal): Promise<RuntimeAdminDrainReceipt>
}

export type RuntimeTransportOptions = {
  socketPath: string
  credentialPath: string
  core: RuntimeCore
  principalId?: string
  ids?: RuntimeIdSource
  chmod?: typeof chmod
  catalog?: MethodRegistry
  admin?: RuntimeAdminBinding
}

export class RuntimeUdsServer {
  readonly #socketPath: string
  readonly #credentialPath: string
  readonly #core: RuntimeCore
  readonly #principalId: string
  readonly #ids: RuntimeIdSource
  readonly #methods = new Map<string, StoredMethod>()
  readonly #chmod: typeof chmod
  readonly #catalog?: MethodRegistry
  readonly #admin?: RuntimeAdminBinding
  #server: ReturnType<typeof Bun.serve> | undefined
  #bootstrapToken: string | undefined
  #adminToken: string | undefined
  #ownsCredential = false
  #ownsSocket = false

  constructor(options: RuntimeTransportOptions) {
    this.#socketPath = options.socketPath
    this.#credentialPath = options.credentialPath
    this.#core = options.core
    this.#principalId = options.principalId ?? "mcp"
    this.#ids = options.ids ?? randomIdSource
    this.#chmod = options.chmod ?? chmod
    this.#catalog = options.catalog
    this.#admin = options.admin === undefined ? undefined : Object.freeze({
      inspect: options.admin.inspect.bind(options.admin), drain: options.admin.drain.bind(options.admin),
    })
  }

  register<Input, Result>(name: string, definition: RuntimeMethodDefinition<Input, Result>): void {
    if (this.#catalog !== undefined) throw new Error("Production catalog owns method registration")
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(name)) throw new Error("Недопустимое имя runtime method")
    if (this.#methods.has(name)) throw new Error(`Runtime method уже зарегистрирован: ${name}`)
    this.#methods.set(name, definition as StoredMethod)
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("Runtime UDS уже запущен")
    const directory = dirname(this.#socketPath)
    if (dirname(this.#credentialPath) !== directory) throw new Error("Socket и credential должны находиться в одном private directory")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.#chmod(directory, 0o700)
    const bootstrapToken = this.#ids.next("bootstrap")
    const adminToken = this.#ids.next("admin")
    try {
      await writeFile(this.#credentialPath, JSON.stringify({
        protocolVersion: "1",
        ...this.#core.generation,
        principalId: this.#principalId,
        bootstrapToken,
        adminToken,
      }), { encoding: "utf8", mode: 0o600, flag: "wx" })
      this.#ownsCredential = true
      await this.#chmod(this.#credentialPath, 0o600)
      this.#bootstrapToken = bootstrapToken
      this.#adminToken = adminToken
      this.#server = Bun.serve({
        unix: this.#socketPath,
        fetch: request => this.#fetch(request),
      })
      this.#ownsSocket = true
      await this.#chmod(this.#socketPath, 0o600)
    } catch (error) {
      this.#server?.stop(true)
      this.#server = undefined
      if (this.#ownsSocket) await unlink(this.#socketPath).catch(() => undefined)
      this.#ownsSocket = false
      if (this.#ownsCredential) await unlink(this.#credentialPath).catch(() => undefined)
      this.#ownsCredential = false
      this.#bootstrapToken = undefined
      this.#adminToken = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#bootstrapToken = undefined
    this.#adminToken = undefined
    if (server !== undefined) server.stop(true)
    await Promise.all([
      this.#ownsSocket ? unlink(this.#socketPath).catch(() => undefined) : undefined,
      this.#ownsCredential ? unlink(this.#credentialPath).catch(() => undefined) : undefined,
    ])
    this.#ownsSocket = false
    this.#ownsCredential = false
  }

  async #fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/v1/admin/")) {
        if (this.#adminToken === undefined || bearerToken(request) !== this.#adminToken) throw new RuntimeContractError("unauthorized", "Неверный admin credential", "runtime-admin")
        if (this.#admin === undefined) return json({ error: "admin-unavailable" }, 503)
        const current = adminInspectionSchema.parse(this.#admin.inspect())
        if (request.method === "GET" && url.pathname === "/v1/admin/inspect") return json(current)
        if (request.method === "POST" && url.pathname === "/v1/admin/drain") {
          const expected = await readJson(request, adminDrainRequestSchema)
          if (current.runtimeEpoch !== expected.runtimeEpoch || current.runtimeBuildId !== expected.buildId
            || expected.nativeBuildId !== undefined && current.nativeBuildId !== expected.nativeBuildId) throw new Error("Admin drain generation/build mismatch")
          const receipt = adminDrainReceiptSchema.parse(await this.#admin.drain(expected, request.signal))
          const after = adminInspectionSchema.parse(this.#admin.inspect())
          if (receipt.runtimeEpoch !== current.runtimeEpoch || receipt.runtimeBuildId !== current.runtimeBuildId
            || receipt.nativeBuildId !== current.nativeBuildId || after.runtimeEpoch !== current.runtimeEpoch
            || after.runtimeBuildId !== current.runtimeBuildId || after.nativeBuildId !== current.nativeBuildId
            || after.activeOperations !== 0 || after.quarantinedResources !== 0) throw new Error("Admin drain receipt не подтверждает inspected host")
          return json(receipt)
        }
        return json({ error: "not-found" }, 404)
      }
      if (request.method === "POST" && url.pathname === "/v1/session/open") {
        this.#assertBootstrap(request)
        const body = await readJson(request, sessionOpenSchema)
        const credential = await this.#core.openClientDurable(this.#principalId)
        return json({ ...credential, clientName: body.clientName })
      }
      if (request.method === "POST" && url.pathname === "/v1/session/resume") {
        this.#assertBootstrap(request)
        const body = await readJson(request, sessionResumeSchema)
        return json(await this.#core.resumeClientDurable(body.resumptionToken))
      }

      const session = this.#authenticate(request)
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        if (this.#catalog === undefined) return json({ error: "catalog-unavailable" }, 503)
        return json(this.#catalog.descriptors())
      }
      const methodMatch = /^\/v1\/tools\/([^/]+)$/.exec(url.pathname)
      if (request.method === "POST" && methodMatch !== null) {
        if (this.#catalog === undefined) return json({ error: "catalog-unavailable" }, 503)
        const body = parseWireJson(z.record(z.string(), z.json()), await readBoundedText(request, 8 * 1024 * 1024), { maxBytes: 8 * 1024 * 1024, maxDepth: 32 })
        const result = await this.#catalog.dispatch(session, decodeURIComponent(methodMatch[1]!), body, request.signal)
        return json(result)
      }
      const frameMatch = /^\/v1\/frames\/([^/]+)$/.exec(url.pathname)
      if (request.method === "GET" && frameMatch !== null) {
        const frame = this.#core.frames.get(decodeURIComponent(frameMatch[1]!), this.#core.clients.lineage(session))
        return frame === undefined ? json({ error: "frame-not-found" }, 404)
          : new Response(frame, { headers: { "content-type": "image/png", "cache-control": "no-store" } })
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return json({
          ok: true,
          generation: this.#core.generation,
          capabilities: this.#core.capabilities,
          native: this.#core.native === undefined ? { state: "unavailable", reason: "adapter not configured" } : { state: "configured" },
          activeOperations: this.#core.activeOperationCount(),
          journalOperations: this.#core.operationCount(),
          quarantinedResources: this.#core.resources.quarantinedCount(),
        })
      }
      const operationMatch = /^\/v1\/operations\/([^/]+)$/.exec(url.pathname)
      if (request.method === "GET" && operationMatch !== null) {
        const operationId = decodeURIComponent(operationMatch[1] ?? "")
        const operation = await this.#core.getOperation(session, operationId)
        return operation === undefined ? json({ error: "operation-not-found" }, 404) : json(operation)
      }
      const requestMatch = /^\/v1\/operations\/by-request\/([^/]+)$/.exec(url.pathname)
      if (request.method === "GET" && requestMatch !== null) {
        const clientRequestId = decodeURIComponent(requestMatch[1] ?? "")
        const operation = await this.#core.getOperationByRequest(session, clientRequestId)
        return operation === undefined ? json({ error: "operation-not-found" }, 404) : json(operation)
      }
      const cancelMatch = /^\/v1\/operations\/([^/]+)\/cancel$/.exec(url.pathname)
      if (request.method === "POST" && cancelMatch !== null) {
        const body = await readJson(request, cancelSchema)
        const operationId = decodeURIComponent(cancelMatch[1] ?? "")
        return json(await this.#core.cancelOperation(session, operationId, body.reason))
      }
      const invokeMatch = /^\/v1\/invoke\/([^/]+)$/.exec(url.pathname)
      if (request.method === "POST" && invokeMatch !== null) {
        const methodName = decodeURIComponent(invokeMatch[1] ?? "")
        const method = this.#methods.get(methodName)
        if (method === undefined) return json({ error: "method-not-found" }, 404)
        const bodyText = await readBoundedText(request, MAX_RUNTIME_REQUEST_BYTES)
        const envelope = parseWireJson(
          invokeEnvelopeSchema(method.input),
          bodyText,
          { maxBytes: MAX_RUNTIME_REQUEST_BYTES, maxDepth: 32 },
        )
        const execution = await this.#core.runOperation(
          session,
          envelope.intent,
          envelope.payload,
          (context, payload) => method.execute(context, payload),
        )
        return json(execution)
      }
      return json({ error: "not-found" }, 404)
    } catch (error) {
      const contract = contractErrorFrom(error, "runtime-uds")
      const status = error instanceof RuntimeContractError && error.contract.code === "unauthorized" ? 401 : 400
      return json({ error: contract }, status)
    }
  }

  #assertBootstrap(request: Request): void {
    const token = bearerToken(request)
    if (this.#bootstrapToken === undefined || token !== this.#bootstrapToken) {
      throw new RuntimeContractError("unauthorized", "Неверный bootstrap credential", "runtime-auth")
    }
  }

  #authenticate(request: Request) {
    try {
      return this.#core.clients.authenticate(bearerToken(request))
    } catch {
      throw new RuntimeContractError("unauthorized", "Неверный runtime session credential", "runtime-auth")
    }
  }
}

export class RuntimeUdsClient {
  readonly #socketPath: string
  #bootstrapToken: string
  #adminToken?: string
  readonly #credentialPath: string
  #bearerToken: string | undefined
  #resumptionToken: string | undefined
  readonly #timeoutMs: number

  private constructor(socketPath: string, credentialPath: string, bootstrapToken: string, timeoutMs: number, adminToken?: string) {
    this.#socketPath = socketPath
    this.#credentialPath = credentialPath
    this.#bootstrapToken = bootstrapToken
    this.#adminToken = adminToken
    this.#timeoutMs = timeoutMs
  }

  static async fromCredentialFile(
    socketPath: string,
    credentialPath: string,
    options: { timeoutMs?: number } = {},
  ): Promise<RuntimeUdsClient> {
    const credential = parseWireJson(bootstrapCredentialSchema, await readFile(credentialPath, "utf8"))
    const timeoutMs = options.timeoutMs ?? RUNTIME_TRANSPORT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Runtime client timeout должен быть 1..30000 ms")
    return new RuntimeUdsClient(socketPath, credentialPath, credential.bootstrapToken, timeoutMs, credential.adminToken)
  }

  async open(clientName: string): Promise<void> {
    const response = await this.#request("/v1/session/open", {
      method: "POST",
      bootstrap: true,
      body: { clientName },
    })
    const credential = sessionCredentialSchema.parse(response)
    this.#bearerToken = credential.bearerToken
    this.#resumptionToken = credential.resumptionToken
  }

  async resume(): Promise<void> {
    if (this.#resumptionToken === undefined) throw new Error("Нет resumption credential")
    const bootstrap = parseWireJson(bootstrapCredentialSchema, await readFile(this.#credentialPath, "utf8"))
    this.#bootstrapToken = bootstrap.bootstrapToken
    this.#adminToken = bootstrap.adminToken
    const response = await this.#request("/v1/session/resume", {
      method: "POST",
      bootstrap: true,
      body: { resumptionToken: this.#resumptionToken },
    })
    const credential = sessionCredentialSchema.parse(response)
    this.#bearerToken = credential.bearerToken
    this.#resumptionToken = credential.resumptionToken
  }

  async health(): Promise<unknown> {
    return this.#request("/v1/health")
  }

  async adminInspect(): Promise<RuntimeAdminInspection> {
    return adminInspectionSchema.parse(await this.#request("/v1/admin/inspect", { admin: true }))
  }

  async adminDrain(expected: RuntimeAdminDrainRequest, signal?: AbortSignal): Promise<RuntimeAdminDrainReceipt> {
    return adminDrainReceiptSchema.parse(await this.#request("/v1/admin/drain", {
      method: "POST", admin: true, body: adminDrainRequestSchema.parse(expected), signal,
    }))
  }

  async listTools(): Promise<RuntimeToolDescriptor[]> {
    const catalog = catalogResponseSchema.parse(await this.#request("/v1/catalog"))
    return catalog.tools as RuntimeToolDescriptor[]
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<RuntimeToolResult> {
    try {
      const catalog = catalogResponseSchema.parse(await this.#request("/v1/catalog", { signal }))
      const descriptor = catalog.tools.find(tool => tool.name === name)
      if (descriptor === undefined) throw new Error("Method отсутствует в текущем runtime catalogue")
      const timeoutMs = Math.max(this.#timeoutMs, (descriptor._meta?.timeoutMs ?? 5000) + 1000)
      const result = methodResponseSchema.parse(await this.#request(`/v1/tools/${encodeURIComponent(name)}`, {
        method: "POST", body: args, signal, timeoutMs,
      }))
      const content: RuntimeToolResult["content"] = [{ type: "text", text: JSON.stringify(result.data) }]
      for (const frameRef of result.frameRefs) {
        const bytes = await this.readFrame(frameRef, signal)
        content.push({ type: "image", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") })
      }
      return { content, structuredContent: result.data, ...(result.isError === undefined ? {} : { isError: result.isError }) }
    } catch (error) {
      if (typeof args.clientRequestId === "string") {
        const operation = await this.getOperationByRequest(args.clientRequestId).catch(() => undefined)
        if (operation !== undefined) return {
          isError: true,
          content: [{ type: "text", text: "Tool response не получен; используйте operation status, не повторяйте действие" }],
          structuredContent: { operation },
        }
      }
      return { isError: true, content: [{ type: "text", text: error instanceof RuntimeUdsHttpError
        ? error.message : "Runtime transport failed; outcome может требовать status lookup" }] }
    }
  }

  async readFrame(frameRef: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.#raw(`/v1/frames/${encodeURIComponent(frameRef)}`, { signal })
    if (!response.ok) throw new RuntimeUdsHttpError(response.status, await readResponseJson(response, this.#timeoutMs))
    if (response.headers.get("content-type") !== "image/png") throw new Error("Runtime frame response имеет другой MIME")
    const bytes = await readBoundedBinary(response, 64 * 1024 * 1024, this.#timeoutMs)
    return bytes
  }

  subscribeCatalogChanged(listener: () => void): () => void {
    const controller = new AbortController()
    let revision: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const catalog = catalogResponseSchema.parse(await this.#request("/v1/catalog", { signal: controller.signal }))
        if (revision !== undefined && catalog.revision !== revision) listener()
        revision = catalog.revision
      } catch { /* Переподключение каталога повторится на следующем ограниченном запросе. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }

  async invoke<Result>(method: string, intent: RuntimeOperationIntent, payload: unknown): Promise<RuntimeExecution<Result>> {
    try {
      return await this.#request(`/v1/invoke/${encodeURIComponent(method)}`, {
        method: "POST",
        body: { intent, payload },
      }) as RuntimeExecution<Result>
    } catch (error) {
      if (error instanceof RuntimeUdsHttpError) throw error
      const operation = await this.getOperationByRequest(intent.clientRequestId).catch(() => undefined)
      throw new RuntimeUnknownDeliveryError(
        operation === undefined
          ? "Runtime invoke delivery неизвестна; status lookup недоступен"
          : `Runtime invoke delivery неизвестна; operation ${operation.context.operationId} зарегистрирована`,
        operation,
        { cause: error },
      )
    }
  }

  async getOperation(operationId: string): Promise<OperationRecord | undefined> {
    const response = await this.#raw(`/v1/operations/${encodeURIComponent(operationId)}`)
    const body = await readResponseJson(response, this.#timeoutMs)
    if (response.status === 404) return undefined
    if (!response.ok) throw new RuntimeUdsHttpError(response.status, body)
    return operationRecordSchema.parse(body)
  }

  async getOperationByRequest(clientRequestId: string): Promise<OperationRecord | undefined> {
    const response = await this.#raw(`/v1/operations/by-request/${encodeURIComponent(clientRequestId)}`)
    const body = await readResponseJson(response, this.#timeoutMs)
    if (response.status === 404) return undefined
    if (!response.ok) throw new RuntimeUdsHttpError(response.status, body)
    return operationRecordSchema.parse(body)
  }

  async cancelOperation(operationId: string, reason: string): Promise<OperationRecord> {
    return operationRecordSchema.parse(await this.#request(`/v1/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: "POST",
      body: { reason },
    }))
  }

  async #request(
    path: string,
    options: { method?: string, body?: unknown, bootstrap?: boolean, admin?: boolean, signal?: AbortSignal, timeoutMs?: number } = {},
  ): Promise<unknown> {
    const response = await this.#raw(path, options)
    const body = await readResponseJson(response, this.#timeoutMs)
    if (!response.ok) throw new RuntimeUdsHttpError(response.status, body)
    return body
  }

  #raw(
    path: string,
    options: { method?: string, body?: unknown, bootstrap?: boolean, admin?: boolean, signal?: AbortSignal, timeoutMs?: number } = {},
  ): Promise<Response> {
    const token = options.admin ? this.#adminToken : options.bootstrap ? this.#bootstrapToken : this.#bearerToken
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    if (token === undefined) throw new Error("Runtime UDS client не аутентифицирован")
    return fetch(`http://localhost${path}`, {
      unix: this.#socketPath,
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal === undefined ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]),
    })
  }
}

const sessionOpenSchema = z.strictObject({ clientName: z.string().min(1).max(128) })
const methodResponseSchema = z.strictObject({ data: z.record(z.string(), z.json()), frameRefs: z.array(z.string().min(1).max(127)).max(4), isError: z.boolean().optional() })
const catalogResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  tools: z.array(z.strictObject({
    name: z.string(), title: z.string(), description: z.string(),
    inputSchema: z.object({ type: z.literal("object") }).passthrough(),
    outputSchema: z.object({ type: z.literal("object") }).passthrough(),
    annotations: z.strictObject({ readOnlyHint: z.boolean(), destructiveHint: z.boolean(), openWorldHint: z.boolean() }),
    _meta: z.strictObject({ maxRequestBytes: z.number().int(), maxResponseBytes: z.number().int(), timeoutMs: z.number().int().min(1).max(120_000).optional() }).optional(),
  })).max(256),
})
const sessionResumeSchema = z.strictObject({ resumptionToken: z.string().min(1).max(256) })
const cancelSchema = z.strictObject({ reason: z.string().min(1).max(1_024) })
const bootstrapCredentialSchema = z.strictObject({
  protocolVersion: z.literal("1"),
  runtimeEpoch: z.string().min(1).max(64),
  loginSessionId: z.string().min(1).max(64),
  principalId: z.string().min(1).max(127),
  bootstrapToken: z.string().min(1).max(256),
  adminToken: z.string().min(1).max(256).optional(),
})
const sessionCredentialSchema = z.strictObject({
  session: z.unknown(),
  bearerToken: z.string().min(1).max(256),
  resumptionToken: z.string().min(1).max(256),
  clientName: z.string().optional(),
})

function invokeEnvelopeSchema<Input>(input: z.ZodType<Input>) {
  return z.strictObject({
    intent: runtimeOperationIntentSchema,
    payload: input,
  })
}

async function readJson<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.output<Schema>> {
  return parseWireJson(schema, await readBoundedText(request, MAX_RUNTIME_REQUEST_BYTES))
}

export async function readBoundedText(request: Request, maxBytes: number, timeoutMs = RUNTIME_TRANSPORT_TIMEOUT_MS): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Runtime request превышает byte limit")
  if (request.body === null) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const deadlineAt = Date.now() + timeoutMs
  try {
    while (true) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw new Error("Runtime request body deadline истёк")
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Runtime request body deadline истёк")), remaining)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error("Runtime request превышает byte limit")
      chunks.push(next.value)
    }
  } catch (error) {
    const cleanupErrors = await cancelAndReleaseReader(reader, error, timeoutMs)
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${error instanceof Error ? error.message : String(error)}; request reader cleanup incomplete`,
      )
    }
    throw error
  } finally {
    if (reader.closed !== undefined) {
      try { reader.releaseLock() } catch {}
    }
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

async function readResponseJson(response: Response, timeoutMs: number): Promise<unknown> {
  const text = await readBoundedResponseText(response, MAX_RUNTIME_RESPONSE_BYTES, timeoutMs)
  return parseWireJson(z.unknown(), text, { maxBytes: MAX_RUNTIME_RESPONSE_BYTES, maxDepth: 32 })
}

export async function readBoundedResponseText(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBinary(response, maxBytes, timeoutMs))
}

async function readBoundedBinary(response: Response, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Runtime response превышает byte limit")
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const deadlineAt = Date.now() + timeoutMs
  try {
    while (true) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw new Error("Runtime response body deadline истёк")
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Runtime response body deadline истёк")), remaining)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error("Runtime response превышает byte limit")
      chunks.push(next.value)
    }
  } catch (error) {
    const cleanupErrors = await cancelAndReleaseReader(reader, error, timeoutMs)
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${error instanceof Error ? error.message : String(error)}; response reader cleanup incomplete`,
      )
    }
    throw error
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization")
  if (header === null || !header.startsWith("Bearer ")) throw new Error("Отсутствует bearer credential")
  return header.slice("Bearer ".length)
}

async function cancelAndReleaseReader(
  reader: { cancel(reason?: unknown): Promise<void>, releaseLock(): void },
  reason: unknown,
  timeoutMs: number,
): Promise<Error[]> {
  const errors: Error[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = reader.cancel(reason)
  try {
    await Promise.race([
      cancel,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("reader cancel deadline exceeded")),
          Math.min(50, Math.max(1, timeoutMs)),
        )
      }),
    ])
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)))
    void cancel.catch(() => undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  try {
    reader.releaseLock()
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }
  return errors
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}
