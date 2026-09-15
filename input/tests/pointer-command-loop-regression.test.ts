import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalRecoveryJson,
  freezeAdapterHostContext,
  heldInputLedgerDigest,
  type AdapterServices,
  type NativeExecutionContext,
  type NativeRecoveryDescriptor,
  type NativeRecoveryGrant,
  type NativeViewAdmission,
  type ObserverCoverage,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  NativeBrokerAdapter,
  NativeProcessTransport,
} from "@meta/native/adapter"
import { DesktopInputAdapter } from "../src/adapter.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-pointer-producer-loop."))
  binary = join(directory, "fixture")
  const repository = join(import.meta.dir, "..", "..")
  const native = join(repository, "native")
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
    join(native, "tests/view-admission-command-loop_fixture.m"),
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
const target = {
  kind: "window" as const,
  ref: {
    ...generation,
    applicationRef: "application-1",
    windowRef: "window-1",
  },
}
const host = freezeAdapterHostContext({
  generation: {
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
  },
  runtimeBuildId: "runtime-pointer-regression",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "pointer-regression",
    capabilities: [
      { id: "input.pointer", state: "ready" },
      { id: "input.drag", state: "ready" },
      { id: "input.keyboard", state: "ready" },
    ],
  },
})

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
): NativeViewAdmission {
  return {
    version: "1",
    contextSha256: digest(wire),
    viewNonce: "view-live-shape-1",
    observerInstanceRef: "observer-1",
    coverageStartCursor: coverage.coverageStartCursor,
    baselineCursor: coverage.cursor,
    baselineNextSequence: coverage.nextSequence,
    observedCursor: coverage.cursor,
    observedNextSequence: coverage.nextSequence,
    admissionCursor: coverage.cursor,
    admissionNextSequence: coverage.nextSequence,
    expiresAt: new Date(Date.parse(wire.deadlineAt) - 100).toISOString(),
  }
}

test("TS pointer producer accepts capture rev10 with fresh target rev11 through C command loop", async () => {
  const reportPath = join(directory, "producer-report.json")
  const native = new NativeBrokerAdapter({
    host,
    adapterInstanceRef: "pointer-regression-native",
    transport: new NativeProcessTransport(binary, ["--normal", reportPath]),
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
          throw new Error("Pointer regression не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
  const now = new Date()
  const deadlineAt = new Date(now.getTime() + 8_000).toISOString()
  const session = {
    clientSessionId: "client-pointer-regression",
    principalId: "principal-pointer-regression",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    authenticationGeneration: "auth-pointer-regression",
    authenticatedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  }
  const wire: NativeExecutionContext = {
    kind: "native",
    operationId: "operation-pointer-regression",
    clientRequestId: "client-request-pointer-regression",
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    ...generation,
    inventoryId: "inventory-current-11",
    inventoryRevision: 11,
    observationRef: {
      observationId: "observation-capture-10",
      inventoryRevision: 10,
      displayLayoutRevision: 1,
      proofRef: "proof-capture-10",
    },
    deadlineAt,
    target,
    fence: { ...generation, counter: 4 },
  }
  const resource = {
    kind: "desktop-input" as const,
    resourceRef: "desktop",
    leaseId: "lease-pointer-regression",
    leaseGeneration: "lease-generation-pointer-regression",
    operationId: wire.operationId,
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    expiresAt: deadlineAt,
    state: "active" as const,
  }
  const context: RuntimeOperationContext<NativeExecutionContext> = {
    wire,
    session,
    resources: [resource],
    control: {
      signal: AbortSignal.timeout(8_000),
      checkpoint: () => undefined,
    },
  }
  const services: AdapterServices = {
    clientSessions: { async assertActive() {} },
    resources: { async assertActive() {}, async assertOwnedSet() {} },
    cleanup: { async verify() {} },
    targets: {
      async resolve(request) {
        return {
          target: request.target,
          resolutionId: "resolution-current-11",
          proofRef: "proof-current-11",
          inventoryId: request.inventoryId,
          inventoryRevision: request.inventoryRevision,
          displayLayoutRevision: 1,
          nativeGeneration: generation.nativeGeneration,
        }
      },
    },
    proofs: { async assertValid() {} },
    evidence: {
      async issueTargetResolution() { throw new Error("not used") },
      async issueFrameFreshness() { throw new Error("not used") },
      async issueWindowCorrelation() { throw new Error("not used") },
      async issueInteractionPoint() { throw new Error("not used") },
    },
    frames: { async publish() {} },
    observations: {
      async resolvePoint(request) {
        return {
          authorized: true,
          observationId: request.observationRef.observationId,
          captureTarget: target,
          interactionTarget: target,
          regionIndex: 0,
          space: {
            kind: "macos-screen" as const,
            display: {
              ...generation,
              displayRef: "display-1",
              displayLayoutRevision: 1,
            },
          },
          imagePoint: request.imagePoint,
          destinationPoint: { x: 135.5, y: 97.75 },
          frameTimestamp: new Date(now.getTime() - 100).toISOString(),
          ownershipProofRef: "proof-owned-point-10",
        }
      },
    },
    continuations: {
      async issue() { throw new Error("not used") },
      async registerAcceptedTask() { throw new Error("not used") },
      async advanceVerifiedStatus() { throw new Error("not used") },
      async markVerifiedTerminal() { throw new Error("not used") },
    },
    reservations: { async assertChild() { throw new Error("not used") } },
  }
  try {
    await native.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-pointer-regression",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: host.runtimeBuildId,
      expectedNativeBuildId: "view-fixture-build",
      capabilitySchemaVersion: "1",
      requiredRecoveryDomainVersion: "1",
      requiredViewAdmissionVersion: "1",
    })
    const prepared = await native.observer({
      kind: "observer",
      protocolVersion: "1",
      command: "prepare",
      requestId: "observer-pointer-regression",
      ...generation,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    }, context.control)
    if (!prepared.ok) throw new Error(prepared.error.message)
    native.configureRecoveryAuthority(async (operation, descriptor) =>
      grant(operation as NativeExecutionContext, descriptor))
    native.configureViewAdmissionAuthorizer(async operation =>
      viewProof(operation, prepared.snapshot.coverage))
    const adapter = new DesktopInputAdapter(host, services, native, {
      now: () => now,
      nextRequestId: () => "native-click-pointer-regression",
    })
    const result = await adapter.execute(context, {
      kind: "click",
      point: { x: 10, y: 20 },
      button: "left",
      count: 1,
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "click",
        destinationPoints: [{ x: 135.5, y: 97.75 }],
      },
      nativeStatus: {
        execution: "finished",
        dispatchAttempts: 3,
        cleanup: "complete",
      },
    })
  } finally {
    await native.close()
  }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    pointerPosts: 1,
    heldDowns: 1,
    heldUps: 1,
    cleanupUps: 0,
  })
})
