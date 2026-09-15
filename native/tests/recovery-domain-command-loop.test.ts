import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalRecoveryJson,
  type ClipboardExecutionContext,
  type NativeExecutionContext,
  type NativeRecoveryDescriptor,
  type NativeRecoveryGrant,
  type z,
} from "@meta/shared/contracts"
import {
  NativeBrokerAdapter,
  NativeProcessTransport,
} from "../src/adapter.ts"
import { nativeClipboardRequestSchema } from "../src/clipboard-protocol.ts"
import {
  NativeTransportStreamDecoder,
  encodeNativeFrame,
  nativeCursorDisplayRequestSchema,
  nativeHitTestRequestSchema,
  nativeInputExecutionRequestSchema,
  nativeInputExecutionResponseSchema,
  type NativeTransportRequestFrame,
  type NativeTransportResponseFrame,
} from "../src/protocol.ts"

type NativeInputExecutionRequest = z.infer<typeof nativeInputExecutionRequestSchema>

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-recovery-domain-loop."))
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
    "recovery-domain/meta_recovery_domain.m",
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
    join(import.meta.dir, "recovery-domain-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 40_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-domain-fixture",
}

const digest = (value: unknown) => new Bun.CryptoHasher("sha256")
  .update(canonicalRecoveryJson(value))
  .digest("hex")

function recoveryGrant(
  wire: NativeExecutionContext | ClipboardExecutionContext,
  descriptor: NativeRecoveryDescriptor,
): NativeRecoveryGrant {
  return {
    policyVersion: "1",
    ...generation,
    operationId: wire.operationId,
    contextSha256: digest(wire),
    descriptor,
    descriptorSha256: digest(descriptor),
    journalRevision: 1,
    durable: true,
  }
}

function textRequest(requestId = "text-request"): NativeInputExecutionRequest {
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  const secret = "Привет"
  return nativeInputExecutionRequestSchema.parse({
    kind: "request",
    protocolVersion: "1",
    requestId,
    ...generation,
    deadlineAt,
    method: "input.execute",
    intent: "mutation",
    operation: {
      kind: "native",
      operationId: `operation-${requestId}`,
      clientRequestId: `client-${requestId}`,
      clientSessionId: "client-1",
      principalId: "principal-1",
      ...generation,
      deadlineAt,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      fence: { ...generation, counter: 1 },
      target: {
        kind: "window",
        ref: {
          ...generation,
          applicationRef: "application-1",
          windowRef: "window-1",
        },
      },
    },
    payload: {
      actionDeadlineAt: deadlineAt,
      action: {
        kind: "text",
        utf16Units: secret.length,
        clusters: [{ text: secret, utf16Units: secret.length, atMs: 0 }],
      },
    },
  })
}

function createAdapter() {
  return new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-domain-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "domain-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "domain-adapter",
    transport: new NativeProcessTransport(binary),
    ledgerSink: {
      async persist() {
        throw new Error("Text fixture не создаёт held ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Domain fixture не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
}

async function handshake(adapter: NativeBrokerAdapter) {
  return await adapter.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake-domain",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-domain-fixture",
    expectedNativeBuildId: "domain-fixture-build",
    capabilitySchemaVersion: "1",
    requiredRecoveryDomainVersion: "1",
  })
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

test("negotiated Domain v1 authorizes valid text before one fake post", async () => {
  const adapter = createAdapter()
  try {
    expect((await handshake(adapter)).recoveryDomainVersion).toBe("1")
    adapter.configureRecoveryAuthority(async (wire, descriptor) =>
      recoveryGrant(wire, descriptor))
    const request = textRequest()
    const response = await adapter.request(
      nativeInputExecutionRequestSchema,
      request,
      nativeInputExecutionResponseSchema,
      control(),
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      completedSteps: 1,
      totalSteps: 1,
      dispatchAttempts: 1,
      status: { execution: "finished", cleanup: "complete" },
    })
  } finally {
    await adapter.close()
  }
})

test("valid clipboard.write no-hold grant passes C admission", async () => {
  const adapter = createAdapter()
  try {
    await handshake(adapter)
    adapter.configureRecoveryAuthority(async (wire, descriptor) =>
      recoveryGrant(wire, descriptor))
    const deadlineAt = new Date(Date.now() + 3_000).toISOString()
    const operation = {
      kind: "clipboard" as const,
      operationId: "operation-clipboard",
      clientRequestId: "client-clipboard",
      clientSessionId: "client-1",
      principalId: "principal-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      deadlineAt,
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      target: {
        kind: "clipboard" as const,
        ref: {
          runtimeEpoch: generation.runtimeEpoch,
          loginSessionId: generation.loginSessionId,
          clipboardRef: "system" as const,
        },
      },
    }
    const response = await adapter.clipboard(nativeClipboardRequestSchema.parse({
      kind: "request",
      protocolVersion: "1",
      requestId: "clipboard-write",
      ...generation,
      deadlineAt,
      operation,
      command: { method: "clipboard.write", payload: { text: "fixture" } },
    }), control())
    expect(response.ok && response.result).toMatchObject({
      method: "clipboard.write",
      value: { status: "written", mutationAttempted: true },
    })
  } finally {
    await adapter.close()
  }
})

type RawSession = {
  child: ReturnType<typeof Bun.spawn>
  next(): Promise<NativeTransportResponseFrame>
  write(frame: NativeTransportRequestFrame | Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

async function rawSession(): Promise<RawSession> {
  const child = Bun.spawn([binary], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const decoder = new NativeTransportStreamDecoder()
  const queued: NativeTransportResponseFrame[] = []
  const write = async (frame: NativeTransportRequestFrame | Record<string, unknown>) => {
    child.stdin.write(encodeNativeFrame(frame))
    await child.stdin.flush()
  }
  const next = async () => {
    while (queued.length === 0) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Domain fixture EOF до response")
      for (const packet of decoder.push(chunk.value)) {
        if (packet.kind === "message") queued.push(packet.frame)
      }
    }
    return queued.shift()!
  }
  await write({
    channel: "handshake",
    payload: {
      kind: "handshake",
      protocolVersion: "1",
      requestId: "raw-handshake",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-domain-fixture",
      expectedNativeBuildId: "domain-fixture-build",
      capabilitySchemaVersion: "1",
      requiredRecoveryDomainVersion: "1",
    },
  })
  expect((await next()).channel).toBe("handshake")
  return {
    child,
    next,
    write,
    async close() {
      child.stdin.end()
      await child.exited
    },
  }
}

function rawGrant(request: NativeInputExecutionRequest) {
  const descriptor: NativeRecoveryDescriptor = {
    policyVersion: "1",
    nativeBuildId: "domain-fixture-build",
    method: "input.execute",
    domain: "possible-held-input",
    possibleHolds: [{ kind: "key", code: 0 }],
  }
  return recoveryGrant(request.operation, descriptor)
}

test.each(["missing", "forged-digest", "wrong-descriptor"] as const)(
  "raw %s recovery grant is rejected by C before handler",
  async scenario => {
    const session = await rawSession()
    try {
      const request = textRequest(`raw-${scenario}`)
      const grant = rawGrant(request)
      const payload = scenario === "missing"
        ? request
        : {
            ...request,
            recoveryGrant: scenario === "forged-digest"
              ? { ...grant, descriptorSha256: "0".repeat(64) }
              : {
                  ...grant,
                  descriptor: {
                    ...grant.descriptor,
                    domain: "no-held-input",
                    possibleHolds: [],
                  },
                  descriptorSha256: digest({
                    ...grant.descriptor,
                    domain: "no-held-input",
                    possibleHolds: [],
                  }),
                },
          }
      await session.write({ channel: "request", payload } as Record<string, unknown>)
      const response = await session.next()
      expect(response.channel).toBe("response")
      if (response.channel !== "response") throw new Error("Expected response")
      expect(response.payload).toMatchObject({
        ok: false,
        error: { code: "request-payload-mismatch" },
      })
      expect(response.payload).not.toHaveProperty("nativeStatus")
    } finally {
      await session.close()
    }
  },
)

test("read-only cursor request has no recovery grant and reaches handler", async () => {
  const session = await rawSession()
  try {
    const request = nativeCursorDisplayRequestSchema.parse({
      kind: "request",
      intent: "read",
      protocolVersion: "1",
      requestId: "cursor-read",
      ...generation,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
      method: "input.cursor-display",
      payload: {
        inventoryId: "inventory-1",
        inventoryRevision: 1,
        displayLayoutRevision: 1,
      },
    })
    await session.write({ channel: "request", payload: request })
    const response = await session.next()
    expect(response.channel).toBe("response")
    if (response.channel !== "response") throw new Error("Expected response")
    expect(response.payload).toMatchObject({
      ok: true,
      result: {
        inventoryId: "inventory-1",
        displayRef: { displayRef: "display-1" },
      },
    })
  } finally {
    await session.close()
  }
})

test("read-only hit-test operation has no recovery grant and reaches handler", async () => {
  const session = await rawSession()
  try {
    const deadlineAt = new Date(Date.now() + 3_000).toISOString()
    const display = {
      ...generation,
      displayRef: "display-1",
      displayLayoutRevision: 1,
    }
    const target = { kind: "display" as const, ref: display }
    const observationRef = {
      observationId: "observation-1",
      inventoryRevision: 1,
      displayLayoutRevision: 1,
      proofRef: "proof-1",
    }
    const request = nativeHitTestRequestSchema.parse({
      kind: "request",
      intent: "read",
      protocolVersion: "1",
      requestId: "hit-test-read",
      ...generation,
      deadlineAt,
      method: "input.hit-test",
      operation: {
        kind: "native",
        operationId: "operation-hit-test",
        clientRequestId: "client-hit-test",
        clientSessionId: "client-1",
        principalId: "principal-1",
        ...generation,
        deadlineAt,
        inventoryId: "inventory-1",
        inventoryRevision: 1,
        observationRef,
        fence: { ...generation, counter: 1 },
        target,
      },
      payload: {
        observationRef,
        frameRef: "frame-1",
        imagePoint: { x: 10, y: 20 },
        interactionTarget: target,
        expectedRegionIndex: 0,
        expectedDestinationPoint: { x: 10, y: 20 },
      },
    })
    await session.write({ channel: "request", payload: request })
    const response = await session.next()
    expect(response.channel).toBe("response")
    if (response.channel !== "response") throw new Error("Expected response")
    expect(response.payload).toMatchObject({
      ok: true,
      result: {
        status: "observation-stale",
        reason: "Injected read-only handler reached without recovery grant",
      },
    })
  } finally {
    await session.close()
  }
})
