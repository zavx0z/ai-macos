import { test, expect } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeHost } from "../../runtime/src/host.ts"
import { z } from "../../shared/src/contracts/schema.ts"
import { createChatExecutor } from "../src/chat-executor.ts"
import { RuntimeCore } from "../../runtime/src/core.ts"
import { MethodRegistry } from "../../runtime/src/method-registry.ts"
import { RuntimeUdsServer } from "../../runtime/src/transport.ts"
import { FixtureBrowserDriver } from "../../runtime/tests/browser-fixture.ts"

const signal = () => new AbortController().signal

test("gateway transports the complete current browser contract without opening Chrome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-browser-contract-"))
  const options = { expectedHostname: hostname(), socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json") }
  const driver = new FixtureBrowserDriver()
  const host = await createRuntimeHost({ ...options, loginSessionId: "login:contract", runtimeBuildId: "runtime:contract", expectedNativeBuildId: "native:unused",
    browser: { chrome: { bindingId: "browser:contract", instances: [{ browserInstanceRef: "chrome:fixture", initialTransportGeneration: "cdp:initial", endpointHost: "127.0.0.1", endpointPort: 9222, profilePath: "/fixture/never-used", driver }] } },
  })
  const proxy = createChatExecutor(options)
  try {
    await host.start()
    const response = await proxy.request!({ node: "computer/browser_chrome_operation" }, signal())
    if (response.isError) {
      console.log("CONTRACT_TRANSPORT_ERROR=" + JSON.stringify(response.content).slice(0, 3000))
      const direct = await host.catalog.dispatch((await host.core.openClientDurable("principal:diagnostic")).session, "agent_request", { node: "computer/browser_chrome_operation" }, signal())
      const depth = (v: unknown): number => v !== null && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0
      console.log("CONTRACT_PAYLOAD_DEPTH=" + depth(direct.data) + " WIRE_DEPTH=" + depth(direct))
    }
    expect(response.isError).not.toBe(true)
    const descriptor = response.structuredContent?.contract as { name?: string; inputSchema?: unknown } | undefined
    expect(descriptor?.name).toBe("browser_chrome_operation")
    expect(JSON.stringify(descriptor?.inputSchema)).toContain("read-resource")
    expect(driver.connectCalls).toBe(0)
  } finally { await proxy.close(); await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test("proxy refuses an old Runtime without agent envelope and never falls back to direct execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-old-runtime-"))
  const options = { expectedHostname: hostname(), socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json") }
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:old", loginSessionId: "login:old" }, runtimeBuildId: "build:old" })
  const catalog = new MethodRegistry(core)
  let calls = 0
  catalog.register("system_health", { title: "Legacy health", description: "Fixture", readOnly: true,
    input: z.strictObject({}), output: z.record(z.string(), z.json()),
    execute: async () => { calls++; return { machine: { hostname: hostname(), matchesExpected: true } } },
  })
  const server = new RuntimeUdsServer({ ...options, core, catalog })
  const proxy = createChatExecutor(options)
  try {
    await server.start()
    await expect(proxy.call("system_health", {}, signal())).rejects.toThrow("agent envelope v1")
    expect(calls).toBe(0)
  } finally { await proxy.close(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

test("proxy bundle contains transport and UI, not Runtime features or embedded tools", async () => {
  const built = await Bun.build({ entrypoints: [new URL("../src/chat-proxy.ts", import.meta.url).pathname], target: "bun" })
  expect(built.success).toBe(true)
  const text = await built.outputs[0]!.text()
  for (const marker of ["DOM_SNAPSHOT_CHANGED", "RESOURCE_SNAPSHOT_CHANGED", "class RuntimeBrowserAdapter", "class AgentViewGuard", "Политика подключения, не вторая схема", "toolsSources", "BrowserDriverCapture", "fixed internal fetch"]) {
    expect(text.includes(marker)).toBe(false)
  }
}, 20000)

test("same proxy discovers a new Runtime operation and hides non-agent methods", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-boundary-"))
  const options = { expectedHostname: hostname(), socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json") }
  const host = await createRuntimeHost({ ...options, loginSessionId: "login:boundary", runtimeBuildId: "runtime:boundary", expectedNativeBuildId: "native:unused" })
  const proxy = createChatExecutor(options)
  let executions = 0
  try {
    await host.start()
    const before = await proxy.listTools()
    expect(before.some(t => t.name === "fixture_collection_v2")).toBe(false)
    host.catalog.register("fixture_collection_v2", {
      agent: true, title: "Runtime-only extension", description: "Fixture only",
      input: z.strictObject({ value: z.string() }), output: z.strictObject({ value: z.string() }), readOnly: true,
      async execute(_context, input) { executions++; return input },
    })
    host.catalog.register("fixture_private", {
      title: "Not exposed", description: "Public Runtime method without agent grant", input: z.strictObject({}), output: z.strictObject({}), readOnly: true,
      async execute() { executions++; return {} },
    })
    const after = await proxy.listTools()
    expect(after.some(t => t.name === "fixture_collection_v2")).toBe(true)
    expect(after.some(t => t.name === "fixture_private")).toBe(false)
    expect((await proxy.call("fixture_collection_v2", { value: "v2" }, signal())).structuredContent).toEqual({ value: "v2" })
    expect((await proxy.call("fixture_private", {}, signal())).isError).toBe(true)
    expect((await proxy.call("agent_request", {}, signal())).isError).toBe(true)
    expect((await proxy.call("fixture_collection_v2", { value: "v2", extra: true }, signal())).isError).toBe(true)
    expect(executions).toBe(1)
    host.catalog.register("too_deep_result", {
      agent: true, title: "Bounded result", description: "Fixture", input: z.strictObject({}), output: z.record(z.string(), z.json()), readOnly: true,
      async execute() {
        let value: Record<string, any> = { end: true }
        for (let i = 0; i < 33; i++) value = { child: value }
        return value
      },
    })
    expect((await proxy.call("too_deep_result", {}, signal())).isError).toBe(true)
  } finally { await proxy.close(); await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 20000)

test("Runtime owns tools descriptions and effects; proxy has no local filesystem executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-files-"))
  const options = { expectedHostname: hostname(), socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json") }
  const host = await createRuntimeHost({ ...options, loginSessionId: "login:files", runtimeBuildId: "runtime:files", expectedNativeBuildId: "native:unused" })
  const proxy = createChatExecutor(options)
  const file = join(directory, "data.txt")
  await writeFile(file, "before")
  try {
    await host.start()
    const contract = await proxy.request!({ node: "tools/filesystem/write", input: { view: "contract" } }, signal())
    expect(contract.isError).not.toBe(true)
    expect(JSON.stringify(contract.structuredContent)).toContain("expectedHash")
    expect(await readFile(file, "utf8")).toBe("before")
    const result = await proxy.request!({ node: "tools/filesystem/write", action: "run", input: { path: file, content: "after" } }, signal())
    expect(result.isError).not.toBe(true)
    expect(await readFile(file, "utf8")).toBe("after")
    host.core.sealAdmission()
    const denied = await proxy.request!({ node: "tools/filesystem/write", action: "run", input: { path: file, content: "forbidden" } }, signal())
    expect(denied.isError).toBe(true)
    expect(await readFile(file, "utf8")).toBe("after")
  } finally { await proxy.close(); await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 20000)
