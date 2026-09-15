import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  freezeAdapterHostContext,
  heldInputLedgerDigest,
  type AdapterServices,
  type HeldInputLedgerAck,
  type NativeExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, NativeProcessTransport } from "@meta/native"
import { DesktopInputAdapter } from "../src/adapter.ts"

const repositoryRoot = join(import.meta.dir, "..", "..")
const runtimeEpoch = "runtime-input-integration-1"
const loginSessionId = "login-input-integration-1"
const nativeGeneration = "native-1"
let fixtureDirectory = ""
let fixturePath = ""
let native: NativeBrokerAdapter
let boundIdentity: {
  adapterInstanceRef: string
  loadedBuildId: string
  generation: { runtimeEpoch: string, loginSessionId: string, nativeGeneration: string }
} | undefined

const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build-input-integration-1",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "input-integration-adapter-1",
    capabilities: [
      { id: "input.pointer", state: "ready" },
      { id: "input.drag", state: "ready" },
      { id: "input.keyboard", state: "ready" },
    ],
  },
})

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "meta-input-integration."))
  fixturePath = join(fixtureDirectory, "broker-fixture")
  const compile = Bun.spawn([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(repositoryRoot, "native", "include")}`,
    join(repositoryRoot, "native", "src", "executor.c"),
    join(repositoryRoot, "native", "src", "ledger.c"),
    join(repositoryRoot, "native", "src", "input_bridge.c"),
    join(repositoryRoot, "native", "tests", "broker_fixture.m"),
    "-framework",
    "Foundation",
    "-o",
    fixturePath,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Не удалось собрать input integration fixture: ${stderr}`)

  native = new NativeBrokerAdapter({
    adapterInstanceRef: "native-adapter-input-integration-1",
    host,
    transport: new NativeProcessTransport(fixturePath),
    bindEvidence(identity) {
      boundIdentity = identity
      return {
        publisher: {
          async publish() { throw new Error("input integration не публикует evidence") },
        },
        sourceResponses: {
          register() { throw new Error("input integration не регистрирует evidence response") },
        },
      }
    },
    ledgerSink: {
      async persist(requestId, snapshot): Promise<HeldInputLedgerAck> {
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
  })
  await native.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake-input-integration-1",
    runtimeEpoch,
    loginSessionId,
    runtimeBuildId: host.runtimeBuildId,
    expectedNativeBuildId: "native-fixture-build-1",
    capabilitySchemaVersion: "1",
  })
})

afterAll(async () => {
  if (native !== undefined) await native.close()
  if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true })
})

describe("C2 InputAdapter → NativeAdapter → C executor", () => {
  test("передаёт готовые Unicode clusters и получает физический status", async () => {
    const current = new Date()
    const deadlineAt = new Date(current.getTime() + 10_000).toISOString()
    const session = {
      clientSessionId: "client-input-integration-1",
      principalId: "principal-input-integration-1",
      runtimeEpoch,
      loginSessionId,
      authenticationGeneration: "auth-input-integration-1",
      authenticatedAt: new Date(current.getTime() - 1_000).toISOString(),
      expiresAt: new Date(current.getTime() + 30_000).toISOString(),
    }
    const target = {
      kind: "window",
      ref: {
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        applicationRef: "application-input-integration-1",
        windowRef: "window-input-integration-1",
      },
    } as const
    const wire: NativeExecutionContext = {
      kind: "native",
      operationId: "operation-input-integration-1",
      clientRequestId: "request-input-integration-1",
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      runtimeEpoch,
      loginSessionId,
      inventoryId: "inventory-input-integration-1",
      inventoryRevision: 1,
      deadlineAt,
      target,
      nativeGeneration,
      fence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
    }
    const resource = {
      kind: "desktop-input",
      resourceRef: "desktop",
      leaseId: "lease-input-integration-1",
      leaseGeneration: "lease-generation-input-integration-1",
      operationId: wire.operationId,
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      runtimeEpoch,
      loginSessionId,
      expiresAt: deadlineAt,
      state: "active",
    } as const
    const context: RuntimeOperationContext<NativeExecutionContext> = {
      wire,
      session,
      resources: [resource],
      control: {
        signal: new AbortController().signal,
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
            resolutionId: "resolution-input-integration-1",
            proofRef: "proof-target-input-integration-1",
            inventoryId: request.inventoryId,
            inventoryRevision: request.inventoryRevision,
            displayLayoutRevision: 1,
            nativeGeneration,
          }
        },
      },
      proofs: { async assertValid() {} },
      evidence: {
        async issueTargetResolution() { throw new Error("не используется") },
        async issueFrameFreshness() { throw new Error("не используется") },
        async issueWindowCorrelation() { throw new Error("не используется") },
        async issueInteractionPoint() { throw new Error("не используется") },
      },
      frames: { async publish() {} },
      observations: { async resolvePoint() { throw new Error("text action не использует observation") } },
      continuations: {
        async issue() { throw new Error("не используется") },
        async registerAcceptedTask() { throw new Error("не используется") },
        async advanceVerifiedStatus() { throw new Error("не используется") },
        async markVerifiedTerminal() { throw new Error("не используется") },
      },
      reservations: { async assertChild() { throw new Error("не используется") } },
    }
    const adapter = new DesktopInputAdapter(host, services, native, {
      now: () => current,
      nextRequestId: (_operationId, purpose) => `native-${purpose}-input-integration-1`,
    })
    const text = "Aя👩‍💻é"
    const result = await adapter.execute(context, { kind: "text", text, delayMs: 5 })

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "text", dispatchedUnits: 4 },
      outcome: {
        dispatch: "finished",
        targetVerified: "verified",
        observation: "unavailable",
        cleanup: { state: "complete" },
      },
      nativeStatus: {
        execution: "finished",
        dispatchAttempts: 4,
        heldCount: 0,
      },
    })
    expect(native.loadedBuildId).toBe("native-fixture-build-1")
    expect(boundIdentity).toEqual({
      adapterInstanceRef: "native-adapter-input-integration-1",
      loadedBuildId: "native-fixture-build-1",
      generation: { runtimeEpoch, loginSessionId, nativeGeneration },
    })
    expect(JSON.stringify(result)).not.toContain(text)
  })
})
