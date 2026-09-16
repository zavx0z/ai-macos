import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalRecoveryJson,
  heldInputLedgerDigest,
  type NativeExecutionContext,
  type NativeRecoveryDescriptor,
  type NativeRecoveryGrant,
  type NativeViewAdmission,
  type ObserverCoverage,
} from "@meta/shared/contracts"
import {
  NativeBrokerAdapter,
  NativeProcessTransport,
} from "../src/adapter.ts"
import {
  nativeInputExecutionRequestSchema,
  nativeInputExecutionResponseSchema,
  type NativeInputExecutionPayload,
} from "../src/protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-view-admission-loop."))
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
    "observer/meta_observer.m",
    "observer-index/meta_observer_target_index.m",
    "observer-command/meta_observer_command.m",
    "input-observer/meta_input_observer_binding.m",
    "view-admission/meta_view_admission.m",
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
    `-I${join(native, "src/observer")}`,
    `-I${join(native, "src/observer-index")}`,
    ...sources,
    join(import.meta.dir, "view-admission-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "AppKit",
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
}, 40_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-view-fixture",
}

const digest = (value: unknown) => new Bun.CryptoHasher("sha256")
  .update(canonicalRecoveryJson(value))
  .digest("hex")

function grant(
  wire: NativeExecutionContext,
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

function viewProof(
  wire: NativeExecutionContext,
  coverage: ObserverCoverage,
  viewNonce: string,
  overrides: Partial<NativeViewAdmission> = {},
): NativeViewAdmission {
  return {
    version: "1",
    contextSha256: digest(wire),
    viewNonce,
    observerInstanceRef: "observer-1",
    coverageStartCursor: coverage.coverageStartCursor,
    baselineCursor: coverage.cursor,
    baselineNextSequence: coverage.nextSequence,
    observedCursor: coverage.cursor,
    observedNextSequence: coverage.nextSequence,
    admissionCursor: coverage.cursor,
    admissionNextSequence: coverage.nextSequence,
    expiresAt: new Date(Date.parse(wire.deadlineAt) - 100).toISOString(),
    ...overrides,
  }
}

function createAdapter(mode?: string, reportPath?: string) {
  return new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-view-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "view-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "view-adapter",
    transport: new NativeProcessTransport(
      binary,
      reportPath === undefined
        ? mode === undefined ? [] : [mode]
        : [mode ?? "--normal", reportPath],
    ),
    ledgerSink: {
      async persist(requestId, snapshot) {
        return {
          requestId,
          operationId: snapshot.operationId,
          runtimeEpoch: snapshot.runtimeEpoch,
          loginSessionId: snapshot.loginSessionId,
          nativeGeneration: snapshot.nativeGeneration,
          revision: snapshot.revision,
          snapshotSha256: heldInputLedgerDigest(snapshot),
          persistedAt: new Date().toISOString(),
          durable: true,
        }
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("View fixture не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

async function setup(mode?: string, reportPath?: string) {
  const adapter = createAdapter(mode, reportPath)
  const handshake = await adapter.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake-view",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-view-fixture",
    expectedNativeBuildId: "view-fixture-build",
    capabilitySchemaVersion: "1",
    requiredRecoveryDomainVersion: "1",
    requiredViewAdmissionVersion: "1",
  })
  expect(handshake).toMatchObject({
    recoveryDomainVersion: "1",
    viewAdmissionVersion: "1",
  })
  const prepared = await adapter.observer({
    kind: "observer",
    protocolVersion: "1",
    command: "prepare",
    requestId: "observer-prepare-view",
    ...generation,
    deadlineAt: new Date(Date.now() + 3_000).toISOString(),
  }, control())
  if (!prepared.ok) throw new Error(prepared.error.message)
  let coverage = prepared.snapshot.coverage
  let viewNonce = "view-1"
  let proofOverrides: Partial<NativeViewAdmission> = {}
  adapter.configureRecoveryAuthority(async (wire, descriptor) =>
    grant(wire as NativeExecutionContext, descriptor))
  adapter.configureViewAdmissionAuthorizer(async wire =>
    viewProof(wire, coverage, viewNonce, proofOverrides))
  return {
    adapter,
    get coverage() { return coverage },
    set coverage(value: ObserverCoverage) { coverage = value },
    set viewNonce(value: string) { viewNonce = value },
    set proofOverrides(value: Partial<NativeViewAdmission>) {
      proofOverrides = value
    },
  }
}

function request(
  action: NativeInputExecutionPayload["action"],
  requestId: string,
  fenceCounter = 1,
  targetOverride?: {
    kind: "display"
    ref: {
      runtimeEpoch: string
      loginSessionId: string
      nativeGeneration: string
      displayRef: string
      displayLayoutRevision: number
    }
  },
) {
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  const pointer = ["hover", "click", "scroll", "drag"].includes(action.kind)
  const observationRef = {
    observationId: `observation-${requestId}`,
    inventoryRevision: 1,
    displayLayoutRevision: 1,
    proofRef: `proof-${requestId}`,
  }
  return nativeInputExecutionRequestSchema.parse({
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId,
    ...generation,
    deadlineAt,
    method: "input.execute",
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
      ...(pointer ? { observationRef } : {}),
      fence: { ...generation, counter: fenceCounter },
      target: targetOverride ?? {
        kind: "window",
        ref: {
          ...generation,
          applicationRef: "application-1",
          windowRef: "window-1",
        },
      },
    },
    payload: { actionDeadlineAt: deadlineAt, action },
  })
}

async function execute(
  adapter: NativeBrokerAdapter,
  input: ReturnType<typeof request>,
) {
  return await adapter.request(
    nativeInputExecutionRequestSchema,
    input,
    nativeInputExecutionResponseSchema,
    control(),
  )
}

async function coverage(adapter: NativeBrokerAdapter) {
  const result = await adapter.observer({
    kind: "observer",
    protocolVersion: "1",
    command: "coverage",
    requestId: `observer-coverage-${crypto.randomUUID()}`,
    ...generation,
    observerInstanceRef: "observer-1",
    deadlineAt: new Date(Date.now() + 2_000).toISOString(),
  }, control())
  if (!result.ok) throw new Error(result.error.message)
  return result.snapshot.coverage
}

const keyAction = {
  kind: "key",
  stroke: { keyCode: 37, flags: 0 },
} as const

test("fresh view admits exactly one key down/up operation", async () => {
  const value = await setup()
  try {
    const response = await execute(value.adapter, request(keyAction, "key-success"))
    if (!response.ok) throw new Error(JSON.stringify(response))
    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({
      completedSteps: 1,
      totalSteps: 1,
      dispatchAttempts: 2,
      status: {
        execution: "finished",
        dispatch: "finished",
        cleanup: "complete",
      },
    })
  } finally {
    await value.adapter.close()
  }
})

test("fresh view admits explicit display hover without window fallback", async () => {
  const value = await setup()
  try {
    const display = {
      kind: "display" as const,
      ref: {
        ...generation,
        displayRef: "display-1",
        displayLayoutRevision: 1,
      },
    }
    const response = await execute(value.adapter, request({
      kind: "hover",
      point: { x: 10, y: 10 },
      modifiers: { names: [], flags: 0 },
    }, "display-hover", 1, display))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      completedSteps: 1,
      dispatchAttempts: 1,
      status: {
        execution: "finished",
        targetVerified: "verified",
        cleanup: "complete",
      },
    })
    expect(response.result.status).not.toHaveProperty("windowRef")
  } finally {
    await value.adapter.close()
  }
})

test.each([
  ["event before native admit", "--event-before-admit", "observation-stale"],
  ["event during target verification", "--event-during-verify", "cancelled"],
] as const)("%s rejects before first physical post", async (_name, mode, code) => {
  const value = await setup(mode)
  try {
    const response = await execute(value.adapter, request(keyAction, `reject-${mode}`))
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Expected view rejection")
    expect(response.error.code).toBe(code)
    expect(response.nativeStatus).toMatchObject({
      dispatch: "none",
      dispatchAttempts: 0,
      cleanup: "complete",
    })
  } finally {
    await value.adapter.close()
  }
})

test("observer gap rejects action or closes transport with zero physical posts", async () => {
  const reportPath = join(directory, `gap-report-${crypto.randomUUID()}.json`)
  const value = await setup("--gap-before-admit", reportPath)
  try {
    const outcome = await execute(
      value.adapter,
      request(keyAction, "gap-before-admit"),
    ).then(response => ({ kind: "response" as const, response }), error => ({ kind: "transport-error" as const, error }))
    if (outcome.kind === "response") {
      expect(outcome.response.ok).toBe(false)
      if (outcome.response.ok) throw new Error("Observer gap не должен допускать action")
      expect(outcome.response.error.code).toBe("observation-stale")
      expect(outcome.response.nativeStatus).toMatchObject({
        execution: "failed",
        dispatch: "none",
        dispatchAttempts: 0,
        cleanup: "complete",
        heldCount: 0,
      })
    } else {
      expect(outcome.error).toBeInstanceOf(Error)
      expect(value.adapter.sessionState.state).toBe("poisoned")
    }
  } finally {
    await value.adapter.close()
  }
  expect(await Bun.file(reportPath).exists()).toBe(true)
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    pointerPosts: 0,
    heldDowns: 0,
    heldUps: 0,
    cleanupUps: 0,
  })
})

test("stale history cursor rejects before dispatch", async () => {
  const value = await setup()
  try {
    value.proofOverrides = {
      baselineCursor: "cursor-stale",
      observedCursor: "cursor-stale",
      admissionCursor: "cursor-stale",
    }
    const response = await execute(value.adapter, request(keyAction, "stale-history"))
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Expected stale rejection")
    expect(response).toMatchObject({
      error: { code: "observation-stale" },
      nativeStatus: { dispatchAttempts: 0, cleanup: "complete" },
    })
  } finally {
    await value.adapter.close()
  }
})

test("replayed view nonce with different operation is rejected", async () => {
  const value = await setup()
  try {
    const first = await execute(value.adapter, request(keyAction, "view-first", 1))
    expect(first.ok).toBe(true)
    value.coverage = await coverage(value.adapter)
    value.viewNonce = "view-1"
    const replay = await execute(value.adapter, request(keyAction, "view-replay", 2))
    expect(replay.ok).toBe(false)
    if (replay.ok) throw new Error("Expected replay rejection")
    expect(replay).toMatchObject({
      error: { code: "observation-stale" },
      nativeStatus: { dispatchAttempts: 0, cleanup: "complete" },
    })
  } finally {
    await value.adapter.close()
  }
})

test("foreign event during second drag point prevents second point and releases owned button", async () => {
  const reportPath = join(directory, `drag-report-${crypto.randomUUID()}.json`)
  const value = await setup("--drag-foreign-second", reportPath)
  try {
    const response = await execute(value.adapter, request({
      kind: "drag",
      button: "left",
      modifiers: { names: [], flags: 0 },
      durationMs: 20,
      trajectory: [
        { point: { x: 10, y: 10 }, atMs: 0 },
        { point: { x: 20, y: 20 }, atMs: 20 },
      ],
    }, "drag-foreign"))
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Expected interrupted drag")
    expect(response.nativeStatus).toMatchObject({
      execution: "cancelled",
      dispatch: "partial",
      dispatchAttempts: 3,
      userInterference: "observed",
      cleanup: "complete",
      heldCount: 0,
      lastCheckpoint: "cleanup-up",
    })
  } finally {
    await value.adapter.close()
  }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    pointerPosts: 1,
    heldDowns: 1,
    heldUps: 0,
    cleanupUps: 1,
  })
})

const clickAction: Extract<NativeInputExecutionPayload["action"], { kind: "click" }> = {
  kind: "click",
  point: { x: 10, y: 10 },
  button: "left",
  count: 1,
  modifiers: { names: [], flags: 0 },
}

test("related AX focus after own button-down does not claim user interference", async () => {
  const reportPath = join(directory, `focus-down-${crypto.randomUUID()}.json`)
  const value = await setup("--focus-after-down", reportPath)
  try {
    const response = await execute(value.adapter, request(clickAction, "focus-after-down"))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.status).toMatchObject({
      execution: "finished",
      dispatch: "finished",
      dispatchAttempts: 3,
      userInterference: "none-observed",
      cleanup: "complete",
    })
  } finally { await value.adapter.close() }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    pointerPosts: 1,
    heldDowns: 1,
    heldUps: 1,
    cleanupUps: 0,
  })
})

test("related AX focus after move but before down cancels without false interference", async () => {
  const reportPath = join(directory, `focus-move-${crypto.randomUUID()}.json`)
  const value = await setup("--focus-after-move", reportPath)
  try {
    const response = await execute(value.adapter, request(clickAction, "focus-after-move"))
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("Expected UI invalidation")
    expect(response.nativeStatus).toMatchObject({
      execution: "cancelled",
      dispatchAttempts: 1,
      userInterference: "none-observed",
      cleanup: "complete",
    })
  } finally { await value.adapter.close() }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    pointerPosts: 1,
    heldDowns: 0,
    heldUps: 0,
    cleanupUps: 0,
  })
})
