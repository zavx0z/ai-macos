import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-command-loop."))
  binary = join(directory, "fixture")
  const root = join(import.meta.dir, "..")
  const compile = Bun.spawn([
    "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    `-I${join(root, "include")}`, join(root, "src/command_loop.m"), join(root, "tests/command_backend_fixture.m"),
    "-framework", "Foundation", "-o", binary,
  ], { stderr: "pipe" })
  const [code, error] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (code !== 0) throw new Error(error)
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true }) })

function createAdapter() {
  return new NativeBrokerAdapter({
    host: {
      generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "command-test", capabilities: [] },
    },
    adapterInstanceRef: "command-adapter", transport: new NativeProcessTransport(binary),
    ledgerSink: { persist: async () => { throw new Error("ledger не используется") } },
    bindEvidence: () => ({ publisher: { publish: async () => { throw new Error("evidence не используется") } }, sourceResponses: { register: () => undefined } }),
  })
}

test("production command loop: verified handshake → coherent clipboard method → sealed drain", async () => {
  const adapter = createAdapter()
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const deadlineAt = new Date(Date.now() + 1_000).toISOString()
    const generation = adapter.generation!
    const response = await adapter.clipboard({
      kind: "request", protocolVersion: "1", requestId: "clipboard", ...generation, deadlineAt,
      operation: {
        kind: "clipboard", operationId: "operation", clientRequestId: "client-request", clientSessionId: "client", principalId: "principal",
        runtimeEpoch: "runtime", loginSessionId: "login", inventoryId: "inventory", inventoryRevision: 0, deadlineAt,
        target: { kind: "clipboard", ref: { runtimeEpoch: "runtime", loginSessionId: "login", clipboardRef: "system" } },
      },
      command: { method: "clipboard.version", payload: {} },
    }, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(response.ok && response.result).toEqual({ method: "clipboard.version", value: { status: "ok", changeCount: 7 } })
    const drain = await adapter.drain({ requestId: "drain", ...generation, deadlineAt }, { signal: new AbortController().signal, checkpoint: () => undefined })
    expect(drain.cleanup).toBe("complete")
    expect(drain.activeOperationIds).toEqual([])
  } finally { await adapter.close() }
})

test("production command loop reports loaded build and rejects incompatible handshake", async () => {
  const adapter = createAdapter()
  try {
    await expect(adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "foreign-build", capabilitySchemaVersion: "1" })).rejects.toThrow("build")
    expect(adapter.generation).toBeUndefined()
  } finally { await adapter.close() }
})
