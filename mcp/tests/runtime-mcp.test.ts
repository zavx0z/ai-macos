import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntimeHost, RuntimeUdsClient } from "@meta/runtime"
import { createRuntimeMcpServer, createUnavailableRuntimeMcpServer } from "../src/runtime-mcp.ts"

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test("thin MCP exposes authenticated runtime health/status/cancel catalog without legacy REST", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-runtime-mcp-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const host = await createRuntimeHost({
    socketPath,
    credentialPath,
    expectedHostname: hostname(),
    loginSessionId: "login:mcp",
    runtimeBuildId: "runtime-build:mcp",
    expectedNativeBuildId: "native-build:mcp",
  })
  await host.start()
  const runtimeClient = await RuntimeUdsClient.fromCredentialFile(socketPath, credentialPath)
  await runtimeClient.open("mcp-test")
  const mcp = createRuntimeMcpServer(runtimeClient)
  const client = new Client({ name: "runtime-mcp-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  cleanup = async () => {
    await client.close()
    await mcp.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }

  const tools = await client.listTools()
  expect(tools.tools.map(tool => tool.name)).toEqual([
    "get_state",
    "observe",
    "get_target_status",
    "cancel_target",
    "recover_startup_input",
    "system_health",
    "get_operation",
    "cancel_operation",
  ])
  const health = await client.callTool({ name: "system_health", arguments: {} })
  expect(health.structuredContent).toMatchObject({
    machine: { matchesExpected: true },
    runtime: { loginSessionId: "login:mcp", buildId: "runtime-build:mcp" },
    native: { state: "unavailable" },
  })
})

test("неподключённый MCP публикует только диагностику и не принимает desktop call", async () => {
  const server = createUnavailableRuntimeMcpServer("machine-mismatch", "different-machine")
  const client = new Client({ name: "diagnostic-mcp-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  cleanup = async () => {
    await client.close()
    await server.close()
  }
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["system_health"])
  const health = await client.callTool({ name: "system_health", arguments: {} })
  expect(health.structuredContent).toMatchObject({
    machine: { matchesExpected: false },
    runtime: { state: "unavailable", reason: "machine-mismatch" },
    servicesProbed: false,
  })
  expect((await client.callTool({ name: "keyboard_type", arguments: { text: "fixture" } })).isError).toBe(true)
})
