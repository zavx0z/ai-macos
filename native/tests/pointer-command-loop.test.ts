import { beforeAll, afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import { nativeInputExecutionRequestSchema, nativeInputExecutionResponseSchema, type NativeInputExecutionPayload } from "../src/protocol.ts"
import { heldInputLedgerDigest } from "@meta/shared/contracts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-pointer-loop."))
  binary = join(directory, "fixture")
  const root = join(import.meta.dir, "..")
  const compile = Bun.spawn(["/usr/bin/clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", `-I${join(root, "include")}`,
    ...["command_loop.m", "broker_transport.m", "input_job.m", "input_executor.m", "executor.c", "ledger.c", "input_bridge.c", "operation-receipts/meta_operation_receipts.m"].map(file => join(root, "src", file)),
    join(root, "tests/command_backend_fixture.m"), "-framework", "Foundation", "-o", binary], { stderr: "pipe" })
  const [exit, errors] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (exit !== 0) throw new Error(errors)
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true }) })

async function execute(action: NativeInputExecutionPayload["action"]) {
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "pointer-fixture", capabilities: [] } },
    adapterInstanceRef: "pointer-adapter", transport: new NativeProcessTransport(binary),
    ledgerSink: { async persist(requestId, snapshot) {
      return { requestId, operationId: snapshot.operationId, runtimeEpoch: snapshot.runtimeEpoch,
        loginSessionId: snapshot.loginSessionId, nativeGeneration: snapshot.nativeGeneration, revision: snapshot.revision,
        snapshotSha256: heldInputLedgerDigest(snapshot), persistedAt: new Date().toISOString(), durable: true }
    } },
    bindEvidence: () => ({ publisher: { publish: async () => { throw new Error("Fixture не публикует evidence") } }, sourceResponses: { register: () => undefined } }),
  })
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake", runtimeEpoch: "runtime", loginSessionId: "login",
      runtimeBuildId: "runtime-build", expectedNativeBuildId: "command-fixture-build", capabilitySchemaVersion: "1" })
    const generation = adapter.generation!
    const deadlineAt = new Date(Date.now() + 3000).toISOString()
    const request = nativeInputExecutionRequestSchema.parse({ kind: "request", protocolVersion: "1", requestId: "pointer", ...generation,
      deadlineAt, method: "input.execute", intent: "mutation", operation: {
        kind: "native", operationId: "pointer-operation", clientRequestId: "pointer-client-request", clientSessionId: "client", principalId: "principal",
        ...generation, deadlineAt, inventoryId: "inventory", inventoryRevision: 1, fence: { ...generation, counter: 1 },
        observationRef: { observationId: "observation-fixture", inventoryRevision: 1, displayLayoutRevision: 1, proofRef: "proof-fixture" },
        target: { kind: "window", ref: { ...generation, applicationRef: "application-fixture", windowRef: "window-fixture" } },
      }, payload: { actionDeadlineAt: deadlineAt, action } })
    return await adapter.request(nativeInputExecutionRequestSchema, request, nativeInputExecutionResponseSchema,
      { signal: new AbortController().signal, checkpoint: () => undefined })
  } finally { await adapter.close() }
}

const modifiers = { names: [], flags: 0 }
test.each([
  { action: { kind: "hover", point: { x: 10, y: 10 }, modifiers }, attempts: 1, steps: 1 },
  { action: { kind: "click", point: { x: 10, y: 10 }, button: "left", count: 1, modifiers }, attempts: 3, steps: 1 },
  { action: { kind: "scroll", anchor: { x: 10, y: 10 }, dx: 0, dy: 1, unit: "line", modifiers }, attempts: 2, steps: 1 },
  { action: { kind: "drag", button: "left", durationMs: 20, modifiers,
    trajectory: [{ point: { x: 10, y: 10 }, atMs: 0 }, { point: { x: 20, y: 20 }, atMs: 20 }] }, attempts: 4, steps: 2 },
] satisfies { action: NativeInputExecutionPayload["action"], attempts: number, steps: number }[])("pointer C dispatch $action.kind", async scenario => {
  const result = await execute(scenario.action)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.result.dispatchAttempts).toBe(scenario.attempts)
  expect(result.result.completedSteps).toBe(scenario.steps)
  expect(result.result.status.cleanup).toBe("complete")
})

test("неподтверждённая point ownership отвергается до первого post", async () => {
  const result = await execute({ kind: "hover", point: { x: 200, y: 10 }, modifiers })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("Ожидался отказ target")
  expect(result.nativeStatus?.dispatchAttempts).toBe(0)
  expect(result.nativeStatus?.targetVerified).toBe("failed")
})
