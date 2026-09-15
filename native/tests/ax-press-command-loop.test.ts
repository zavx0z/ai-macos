import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import {
  nativeAxInspectionRequestSchema,
  nativeAxInspectionResponseSchema,
  nativeAxPressRequestSchema,
  nativeAxPressResponseSchema,
} from "../src/protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-ax-press-command-loop."))
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
    "accessibility/meta_ax_inspector.m",
    "ax-actions/meta_ax_retained_snapshot.m",
    "ax-actions/meta_ax_press.m",
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
    ...sources,
    join(import.meta.dir, "ax-press-command-loop_fixture.m"),
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

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-ax-press-fixture",
}
const target = {
  kind: "window" as const,
  ref: {
    ...generation,
    applicationRef: "application-1",
    windowRef: "window-1",
  },
}

function adapter(args: string[]) {
  return new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-ax-press-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "ax-press-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "ax-press-adapter",
    transport: new NativeProcessTransport(binary, args),
    ledgerSink: {
      async persist() {
        throw new Error("AXPress fixture не создаёт held-input ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("AXPress fixture не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
}

async function execute(args: string[]) {
  const native = adapter(args)
  await native.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake-ax-press",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-ax-press-fixture",
    expectedNativeBuildId: "ax-press-fixture-build",
    capabilitySchemaVersion: "1",
  })
  const control = {
    signal: AbortSignal.timeout(5_000),
    checkpoint: () => undefined,
  }
  const inspect = nativeAxInspectionRequestSchema.parse({
    kind: "request",
    intent: "read",
    protocolVersion: "1",
    requestId: "inspect-ax-press",
    ...generation,
    deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    method: "ax.inspect",
    payload: { target, depth: 12, maxNodes: 32, maxBytes: 1024 * 1024 },
  })
  const inspected = await native.request(
    nativeAxInspectionRequestSchema,
    inspect,
    nativeAxInspectionResponseSchema,
    control,
  )
  if (!inspected.ok) throw new Error(inspected.error.message)
  const rawButton = inspected.result.nodes.find(node =>
    node.actions.includes("AXPress")
  )
  if (rawButton === undefined) throw new Error("Fixture AXPress node отсутствует")
  const element = {
    ...generation,
    applicationRef: target.ref.applicationRef,
    snapshotId: inspected.result.snapshotId,
    elementRef: rawButton.elementRef,
  }
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  const request = nativeAxPressRequestSchema.parse({
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId: `press-${args[0] ?? "success"}`,
    ...generation,
    deadlineAt,
    method: "ax.press",
    operation: {
      kind: "native",
      operationId: `operation-${args[0] ?? "success"}`,
      clientRequestId: "client-request-ax-press",
      clientSessionId: "client-ax-press",
      principalId: "principal-ax-press",
      ...generation,
      deadlineAt,
      inventoryId: "inventory-1",
      inventoryRevision: 7,
      fence: { ...generation, counter: 1 },
      target,
    },
    payload: { element },
  })
  const response = await native.request(
    nativeAxPressRequestSchema,
    request,
    nativeAxPressResponseSchema,
    control,
  )
  return { native, response }
}

test("framed AXPress выполняет один gated perform без effect claim", async () => {
  const { native, response } = await execute([])
  try {
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      value: { action: "AXPress", performed: true },
      status: {
        execution: "finished",
        dispatch: "finished",
        dispatchAttempts: 1,
        cleanup: "complete",
      },
    })
    expect(response.result.value).not.toHaveProperty("effectVerified")
  } finally {
    await native.close()
  }
})

test.each([
  ["stale snapshot", ["--stale-snapshot"], "target-stale"],
  ["foreign parent", ["--foreign-parent"], "target-stale"],
] as const)("framed AXPress rejects %s before dispatch", async (_name, args, code) => {
  const { native, response } = await execute([...args])
  try {
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Ожидался AXPress failure")
    expect(response.error.code).toBe(code)
    expect(response.nativeStatus).toMatchObject({
      execution: "failed",
      dispatch: "none",
      dispatchAttempts: 0,
      cleanup: "complete",
    })
  } finally {
    await native.close()
  }
})

test("framed AXPress сохраняет фактический AX error как один attempt", async () => {
  const { native, response } = await execute(["--ax-error"])
  try {
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Ожидался AXPress failure")
    expect(response.error.code).toBe("operation-outcome-unknown")
    expect(response.nativeStatus).toMatchObject({
      execution: "failed",
      dispatchAttempts: 1,
      cleanup: "complete",
    })
    expect(response.nativeStatus?.dispatch).not.toBe("none")
  } finally {
    await native.close()
  }
})
