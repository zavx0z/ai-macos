import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const mcpPackageDirectory = resolve(import.meta.dir, "../../mcp")
const runtimePackageEntry = Bun.resolveSync("@meta/runtime", mcpPackageDirectory)
const contractsPackageEntry = Bun.resolveSync(
  "@meta/shared/contracts",
  mcpPackageDirectory
)
const sdkClientEntry = Bun.resolveSync(
  "@modelcontextprotocol/sdk/client/index.js",
  mcpPackageDirectory
)
const sdkMemoryEntry = Bun.resolveSync(
  "@modelcontextprotocol/sdk/inMemory.js",
  mcpPackageDirectory
)
const sdkTypesEntry = Bun.resolveSync(
  "@modelcontextprotocol/sdk/types.js",
  mcpPackageDirectory
)
const mcpServerEntry = resolve(mcpPackageDirectory, "src/runtime-mcp.ts")
const { createRuntimeHost, RuntimeUdsClient } = await import(runtimePackageEntry)
const { z } = await import(contractsPackageEntry)
const { Client } = await import(sdkClientEntry)
const { InMemoryTransport } = await import(sdkMemoryEntry)
const { ToolListChangedNotificationSchema } = await import(sdkTypesEntry)
const { createRuntimeMcpServer } = await import(mcpServerEntry)

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
))

class InjectedNativeTransport {
  readonly capabilities: Array<{ id: string; state: "ready" }> = [
    { id: "desktop.applications", state: "ready" },
    { id: "desktop.windows.all", state: "ready" },
    { id: "desktop.displays", state: "ready" }
  ]
  readonly packetsQueue: unknown[] = []
  requestCalls = 0
  drainCalls = 0
  closed = false
  ended = false
  private waiter?: (packet: unknown | undefined) => void

  async send(frame: Record<string, any>): Promise<void> {
    if (frame.channel === "handshake") {
      this.push({
        kind: "message",
        frame: {
          channel: "handshake",
          payload: {
            kind: "handshake-response",
            protocolVersion: "1",
            requestId: frame.payload.requestId,
            runtimeEpoch: frame.payload.runtimeEpoch,
            loginSessionId: frame.payload.loginSessionId,
            nativeGeneration: "native-host-acceptance",
            nativeBuildId: "native-build-host-acceptance",
            capabilitySchemaVersion: "1",
            installRoot: "/tmp/native-host-acceptance",
            process: {
              pid: 4242,
              startedAt: new Date().toISOString(),
              nonce: "process-host-acceptance"
            },
            capabilities: {
              scope: "adapter",
              schemaVersion: "1",
              producerRef: "native-host-acceptance",
              capabilities: this.capabilities
            }
          }
        }
      })
      return
    }
    if (frame.channel === "drain") {
      this.drainCalls += 1
      this.push({
        kind: "message",
        frame: {
          channel: "drain",
          payload: {
            requestId: frame.payload.requestId,
            runtimeEpoch: frame.payload.runtimeEpoch,
            loginSessionId: frame.payload.loginSessionId,
            nativeGeneration: frame.payload.nativeGeneration,
            accepted: true,
            activeOperationIds: [],
            cleanup: "complete",
            quarantined: false
          }
        }
      })
      return
    }
    this.requestCalls += 1
    throw new Error(`Unexpected native channel: ${String(frame.channel)}`)
  }

  async *packets(signal: AbortSignal): AsyncIterable<any> {
    while (!signal.aborted && !this.ended) {
      const packet = await this.next(signal)
      if (packet === undefined) return
      yield packet
    }
  }

  disconnect(): void {
    this.ended = true
    this.waiter?.(undefined)
    this.waiter = undefined
  }

  async close(): Promise<void> {
    this.closed = true
    this.disconnect()
  }

  private push(packet: unknown): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter(packet)
      return
    }
    this.packetsQueue.push(packet)
  }

  private next(signal: AbortSignal): Promise<unknown | undefined> {
    const packet = this.packetsQueue.shift()
    if (packet !== undefined) return Promise.resolve(packet)
    if (this.ended || signal.aborted) return Promise.resolve(undefined)
    return new Promise((done) => {
      const onAbort = () => {
        if (this.waiter === done) this.waiter = undefined
        done(undefined)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.waiter = (value) => {
        signal.removeEventListener("abort", onAbort)
        done(value)
      }
    })
  }
}

async function createHost(transport?: InjectedNativeTransport) {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-host-mcp-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const host = await createRuntimeHost({
    socketPath,
    credentialPath,
    runtimeBuildId: "runtime-build-host-acceptance",
    expectedNativeBuildId: "native-build-host-acceptance",
    loginSessionId: "login-host-acceptance",
    expectedHostname: hostname(),
    ...(transport === undefined ? {} : { transport })
  })
  await host.start()
  return { directory, socketPath, credentialPath, host }
}

async function connectMcp(
  socketPath: string,
  credentialPath: string,
  name: string
) {
  const runtimeClient = await RuntimeUdsClient.fromCredentialFile(
    socketPath,
    credentialPath
  )
  await runtimeClient.open(name)
  const server = createRuntimeMcpServer(runtimeClient)
  const client = new Client({ name, version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ])
  return { runtimeClient, server, client }
}

async function waitForCatalogChange(client: any): Promise<void> {
  let changed: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const notification = new Promise<void>((done) => { changed = done })
  client.setNotificationHandler(
    ToolListChangedNotificationSchema,
    async () => { changed?.() }
  )
  await new Promise((done) => setTimeout(done, 50))
  try {
    await Promise.race([
      notification,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("MCP catalogChanged timeout")),
          2500
        )
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test("RuntimeHost → UDS → MCP изолирует frames двух client lineages и unavailable dispatch", async () => {
  const fixture = await createHost()
  const connections: Array<Awaited<ReturnType<typeof connectMcp>>> = []
  let unavailableCalls = 0
  try {
    fixture.host.catalog.register("fixture_frame", {
      title: "Acceptance frame",
      description: "Возвращает client-scoped fixture frame",
      readOnly: true,
      input: z.strictObject({}),
      output: z.strictObject({ frameRef: z.string() }),
      async execute(context: Record<string, any>) {
        const target = {
          kind: "browser-target" as const,
          ref: {
            ...fixture.host.core.generation,
            browserInstanceRef: "browser-host-acceptance",
            transportGeneration: "transport-host-acceptance",
            targetId: "target-host-acceptance",
            resourceRef: "resource-host-acceptance"
          }
        }
        const frameRef = `frame:${crypto.randomUUID()}`
        const observationId = `observation:${crypto.randomUUID()}`
        fixture.host.core.frames.registerPublication({
          observationId,
          frameRef,
          ...fixture.host.core.generation,
          source: "browser-viewport",
          captureTarget: target,
          capturePolicySha256: "a".repeat(64),
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          inventoryId: "inventory-host-acceptance",
          inventoryRevision: 1,
          displayLayoutRevision: 0,
          cacheScopeRef: fixture.host.core.clients.lineage(context.session)
        })
        await fixture.host.core.frames.publish({
          observationId,
          frameRef,
          ...fixture.host.core.generation,
          source: "browser-viewport",
          target,
          capturedAt: new Date().toISOString(),
          widthPx: 1,
          heightPx: 1,
          mime: "image/png",
          expectedByteLength: png.byteLength,
          expectedSha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
          bytes: png
        })
        return { frameRef }
      },
      frames: (output: { frameRef: string }) => [output.frameRef]
    })
    fixture.host.catalog.register("fixture_unavailable", {
      title: "Unavailable acceptance method",
      description: "Не должен рекламироваться или достигать executor",
      readOnly: true,
      input: z.strictObject({}),
      output: z.strictObject({ reached: z.boolean() }),
      requiredCapabilities: ["browser.instances"],
      async execute() {
        unavailableCalls += 1
        return { reached: true }
      }
    })

    const first = await connectMcp(
      fixture.socketPath,
      fixture.credentialPath,
      "acceptance-mcp-first"
    )
    const second = await connectMcp(
      fixture.socketPath,
      fixture.credentialPath,
      "acceptance-mcp-second"
    )
    connections.push(first, second)

    const listed = await first.client.listTools()
    expect(listed.tools.some((tool: any) => tool.name === "fixture_frame")).toBe(true)
    expect(listed.tools.some((tool: any) => tool.name === "fixture_unavailable")).toBe(false)
    const rejected = await first.client.callTool({
      name: "fixture_unavailable",
      arguments: {}
    })
    expect(rejected.isError).toBe(true)
    expect(unavailableCalls).toBe(0)

    const frame = await first.client.callTool({
      name: "fixture_frame",
      arguments: {}
    })
    expect(frame.content.some((item: any) => item.type === "image")).toBe(true)
    const frameRef = String((frame.structuredContent as any)?.frameRef)
    await expect(second.runtimeClient.readFrame(frameRef)).rejects.toThrow("404")
    expect(await first.runtimeClient.readFrame(frameRef)).toEqual(png)
  } finally {
    for (const connection of connections.reverse()) {
      await connection.client.close()
      await connection.server.close()
    }
    await fixture.host.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test("native disconnect меняет MCP catalog и не допускает unavailable dispatch", async () => {
  const transport = new InjectedNativeTransport()
  const fixture = await createHost(transport)
  const connection = await connectMcp(
    fixture.socketPath,
    fixture.credentialPath,
    "acceptance-mcp-disconnect"
  )
  try {
    expect((await connection.client.listTools()).tools.some(
      (tool: any) => tool.name === "list_windows"
    )).toBe(true)
    const changed = waitForCatalogChange(connection.client)
    transport.disconnect()
    await changed
    expect((await connection.client.listTools()).tools.some(
      (tool: any) => tool.name === "list_windows"
    )).toBe(false)
    const rejected = await connection.client.callTool({
      name: "list_windows",
      arguments: {}
    })
    expect(rejected.isError).toBe(true)
    expect(transport.requestCalls).toBe(0)
  } finally {
    await connection.client.close()
    await connection.server.close()
    await fixture.host.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test("RuntimeHost bounded drain закрывает dynamic MCP admission и подтверждается native ACK", async () => {
  const transport = new InjectedNativeTransport()
  const fixture = await createHost(transport)
  const connection = await connectMcp(
    fixture.socketPath,
    fixture.credentialPath,
    "acceptance-mcp-drain"
  )
  try {
    expect((await connection.client.listTools()).tools.some(
      (tool: any) => tool.name === "list_windows"
    )).toBe(true)
    const changed = waitForCatalogChange(connection.client)
    const startedAt = performance.now()
    const drain = await fixture.host.drain()
    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(drain.cleanup).toBe("complete")
    expect(transport.drainCalls).toBe(1)
    await changed
    const after = await connection.client.listTools()
    expect(after.tools.some((tool: any) => tool.name === "list_windows")).toBe(false)
    expect(after.tools.some((tool: any) => tool.name === "system_health")).toBe(true)
  } finally {
    await connection.client.close()
    await connection.server.close()
    await fixture.host.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
