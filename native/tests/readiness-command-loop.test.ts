import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import { nativeInputReadinessRequestSchema } from "../src/protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-readiness-command-loop."))
  binary = join(directory, "fixture")
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m",
    "broker_transport.m",
    "operation-receipts/meta_operation_receipts.m",
    "input_job.m",
    "input_executor.m",
    "input_bridge.c",
    "executor.c",
    "ledger.c",
    "readiness/meta_input_readiness.c",
    "readiness-command/meta_readiness_command.m",
  ].map(path => join(native, "src", path))
  const compile = Bun.spawn([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-fblocks",
    "-mmacosx-version-min=13.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(native, "include")}`,
    `-I${join(native, "src")}`,
    `-I${join(native, "src/readiness")}`,
    `-I${join(native, "src/readiness-command")}`,
    ...sources,
    join(import.meta.dir, "readiness-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "ApplicationServices",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 20_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

test.each([
  {
    name: "ready",
    args: [] as string[],
    inputReady: true,
    execution: "finished",
    dispatch: "finished",
    attempts: 2,
  },
  {
    name: "observer unavailable",
    args: ["--observer-unavailable"],
    inputReady: false,
    execution: "failed",
    dispatch: "none",
    attempts: 0,
  },
])("framed input readiness: $name", async scenario => {
  const adapter = new NativeBrokerAdapter({
    host: {
      generation: { runtimeEpoch: "runtime-1", loginSessionId: "login-1" },
      runtimeBuildId: "runtime-readiness-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "readiness-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "readiness-adapter",
    transport: new NativeProcessTransport(binary, scenario.args),
    ledgerSink: {
      async persist() {
        throw new Error("Readiness fixture не создаёт held-input ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Readiness fixture не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
  try {
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-readiness",
      runtimeEpoch: "runtime-1",
      loginSessionId: "login-1",
      runtimeBuildId: "runtime-readiness-fixture",
      expectedNativeBuildId: "readiness-fixture-build",
      capabilitySchemaVersion: "1",
    })
    const generation = adapter.generation!
    const deadlineAt = new Date(Date.now() + 3_000).toISOString()
    const display = {
      ...generation,
      displayRef: "display-1",
      displayLayoutRevision: 1,
    }
    const request = nativeInputReadinessRequestSchema.parse({
      kind: "request",
      intent: "mutation",
      protocolVersion: "1",
      requestId: `readiness-${scenario.name.replaceAll(" ", "-")}`,
      ...generation,
      deadlineAt,
      method: "input.readiness",
      operation: {
        kind: "native",
        operationId: `operation-${scenario.name.replaceAll(" ", "-")}`,
        clientRequestId: "client-request-readiness",
        clientSessionId: "client-readiness",
        principalId: "principal-readiness",
        ...generation,
        deadlineAt,
        inventoryId: "inventory-readiness",
        inventoryRevision: 1,
        fence: { ...generation, counter: 1 },
        target: { kind: "display", ref: display },
      },
      payload: { expectedDisplayRef: display },
    })
    const response = await adapter.inputReadiness(request, control())
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      value: {
        inputReady: scenario.inputReady,
        expectedDisplayRef: display,
      },
      status: {
        operationId: request.operation.operationId,
        execution: scenario.execution,
        dispatch: scenario.dispatch,
        dispatchAttempts: scenario.attempts,
        cleanup: "complete",
        quarantined: false,
      },
    })
    expect(response.result.value.inputReady).toBe(scenario.inputReady)
  } finally {
    await adapter.close()
  }
})
