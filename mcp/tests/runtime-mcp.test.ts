import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { RuntimeCore, RuntimeUdsClient, RuntimeUdsServer } from "@meta/runtime"
import { createRuntimeMcpServer } from "../src/runtime-mcp.ts"

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test("thin MCP exposes authenticated runtime health/status/cancel catalog without legacy REST", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-runtime-mcp-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const core = new RuntimeCore({
    generation: { runtimeEpoch: "runtime:mcp", loginSessionId: "login:mcp" },
    runtimeBuildId: "runtime-build:mcp",
  })
  const uds = new RuntimeUdsServer({ socketPath, credentialPath, core })
  await uds.start()
  const runtimeClient = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
  await runtimeClient.open("mcp-test")
  const mcp = createRuntimeMcpServer(runtimeClient)
  const client = new Client({ name: "runtime-mcp-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  cleanup = async () => {
    await client.close()
    await mcp.close()
    await uds.stop()
    await rm(directory, { recursive: true, force: true })
  }

  const tools = await client.listTools()
  expect(tools.tools.map(tool => tool.name)).toEqual([
    "system_health",
    "get_operation",
    "cancel_operation",
  ])
  const health = await client.callTool({ name: "system_health", arguments: {} })
  expect(health.structuredContent).toMatchObject({
    ok: true,
    generation: { runtimeEpoch: "runtime:mcp", loginSessionId: "login:mcp" },
    native: { state: "unavailable" },
  })
})
