import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import {
  nativeCursorDisplayRequestSchema,
  nativeCursorDisplayResponseSchema,
  nativeCursorDisplayResultMatches,
} from "../src/cursor-display-protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-cursor-display-loop."))
  binary = join(directory, "fixture")
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m",
    "broker_transport.m",
    "operation-receipts/meta_operation_receipts.m",
    "input_job.m",
    "registry.c",
    "macos_backend.m",
    "window-actions/meta_window_readback.c",
    "input-target/meta_geometry_probe.m",
    "cursor-display/meta_cursor_display.m",
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
    join(import.meta.dir, "cursor-display-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "CoreGraphics",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 30_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

const scenarios = [
  {
    name: "resolved negative-origin display",
    args: [] as string[],
    inventoryRevision: 7,
    status: "resolved" as const,
  },
  {
    name: "ambiguous overlap",
    args: ["ambiguous"],
    inventoryRevision: 7,
    status: "ambiguous" as const,
  },
  {
    name: "stale topology epoch",
    args: ["stale-epoch"],
    inventoryRevision: 7,
    status: "stale-inventory" as const,
  },
  {
    name: "stale inventory revision",
    args: [] as string[],
    inventoryRevision: 8,
    status: "stale-inventory" as const,
  },
]

test.each(scenarios)("framed cursor display: $name", async scenario => {
  const sourceResponses = new Map<string, Uint8Array>()
  let ledgerWrites = 0
  const checkpoints: string[] = []
  const adapter = new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-cursor-display-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "cursor-display-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "cursor-display-adapter",
    transport: new NativeProcessTransport(binary, scenario.args),
    ledgerSink: {
      async persist() {
        ledgerWrites += 1
        throw new Error("Passive cursor display не создаёт held-input ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Cursor display trace не является target proof")
        },
      },
      sourceResponses: {
        register(ref, bytes) {
          if (sourceResponses.has(ref)) throw new Error(`Повторный source response ref: ${ref}`)
          sourceResponses.set(ref, Uint8Array.from(bytes))
        },
      },
    }),
  })
  try {
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: `handshake-${scenario.name.replaceAll(" ", "-")}`,
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-cursor-display-fixture",
      expectedNativeBuildId: "cursor-display-fixture-build",
      capabilitySchemaVersion: "1",
    })
    const request = nativeCursorDisplayRequestSchema.parse({
      kind: "request",
      protocolVersion: "1",
      requestId: `cursor-${scenario.name.replaceAll(" ", "-")}`,
      ...generation,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      intent: "read",
      method: "input.cursor-display",
      payload: {
        inventoryId: "inventory-7",
        inventoryRevision: scenario.inventoryRevision,
        displayLayoutRevision: 3,
      },
    })
    const response = await adapter.request(
      nativeCursorDisplayRequestSchema,
      request,
      nativeCursorDisplayResponseSchema,
      {
        signal: control().signal,
        checkpoint(stage) {
          checkpoints.push(stage)
        },
      },
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.status).toBe(scenario.status)
    expect(nativeCursorDisplayResultMatches(request, response.result)).toBe(true)
    expect("operationId" in response).toBe(false)
    expect("operation" in request).toBe(false)
    expect("fence" in request).toBe(false)
    expect(checkpoints).toEqual(["native-before-request", "native-after-response"])
    expect(ledgerWrites).toBe(0)
    expect([...sourceResponses.keys()]).toEqual([response.result.sourceResponseRef])
    const raw = sourceResponses.get(response.result.sourceResponseRef)
    expect(raw).toBeDefined()
    const rawText = new TextDecoder().decode(raw)
    expect(rawText.includes(response.result.sourceResponseRef)).toBe(true)
    expect(rawText).not.toContain('"operationId"')
    expect(rawText).not.toContain('"fence"')
    expect(rawText).not.toContain('"nativeStatus"')
    expect(rawText).not.toContain('"dispatch"')
    if (response.result.status === "resolved") {
      expect(response.result).toMatchObject({
        cursor: { x: -640, y: 500 },
        inventoryId: "inventory-7",
        inventoryRevision: 7,
        displayLayoutRevision: 3,
        displayRef: {
          ...generation,
          displayRef: "display-left",
          displayLayoutRevision: 3,
        },
      })
    } else {
      expect(response.result).not.toHaveProperty("displayRef")
      expect(response.result.reason.length).toBeGreaterThan(0)
    }
    expect(nativeCursorDisplayRequestSchema.safeParse({
      ...request,
      operation: { operationId: "operation-forbidden" },
    }).success).toBe(false)
    expect(nativeCursorDisplayRequestSchema.safeParse({
      ...request,
      fence: { ...generation, counter: 1 },
    }).success).toBe(false)
  } finally {
    await adapter.close()
  }
})
