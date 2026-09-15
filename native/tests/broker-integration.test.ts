import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  heldInputLedgerDigest,
  type AdapterHostContext,
  type HeldInputLedgerAck,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import {
  nativeInputExecutionRequestSchema,
  nativeInputExecutionResponseSchema,
} from "../src/protocol.ts"

const repositoryRoot = join(import.meta.dir, "..", "..")
let fixtureDirectory = ""
let fixturePath = ""

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "meta-native-broker."))
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
  const [code, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Не удалось собрать broker fixture: ${stderr}`)
})

afterAll(async () => {
  if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-1",
}

function host(): AdapterHostContext {
  return {
    generation: {
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
    },
    runtimeBuildId: "runtime-build-1",
    capabilities: {
      schemaVersion: "1",
      scope: "adapter",
      producerRef: "broker-integration-fixture",
      capabilities: [],
    },
  }
}

describe("native framed broker", () => {
  test("исполняет key через production executor только после durable ledger ACK", async () => {
    const ledgerRevisions: number[] = []
    const adapter = new NativeBrokerAdapter({
      adapterInstanceRef: "native-broker-fixture",
      bindEvidence: () => ({
        publisher: { publish: async () => { throw new Error("evidence не ожидался") } },
        sourceResponses: { register: () => undefined },
      }),
      host: host(),
      transport: new NativeProcessTransport(fixturePath),
      ledgerSink: {
        async persist(requestId, snapshot): Promise<HeldInputLedgerAck> {
          ledgerRevisions.push(snapshot.revision)
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
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-integration-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-fixture-build-1",
      capabilitySchemaVersion: "1",
    })
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    const response = await adapter.request(
      nativeInputExecutionRequestSchema,
      {
        kind: "request",
        protocolVersion: "1",
        requestId: "input-integration-1",
        ...generation,
        deadlineAt,
        intent: "mutation",
        method: "input.execute",
        operation: {
          kind: "native",
          operationId: "operation-integration-1",
          clientRequestId: "client-request-integration-1",
          clientSessionId: "client-session-integration-1",
          principalId: "principal-integration-1",
          ...generation,
          inventoryId: "inventory-integration-1",
          inventoryRevision: 1,
          target: {
            kind: "window",
            ref: {
              ...generation,
              applicationRef: "application-integration-1",
              windowRef: "window-integration-1",
            },
          },
          fence: { ...generation, counter: 1 },
          deadlineAt,
        },
        payload: {
          actionDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
          action: {
            kind: "key",
            stroke: { keyCode: 55, flags: 0x0010_0000 },
          },
        },
      },
      nativeInputExecutionResponseSchema,
      {
        signal: new AbortController().signal,
        checkpoint: () => undefined,
      },
    )
    if (!response.ok) throw new Error(response.error.message)
    expect(response.ok).toBe(true)
    expect(ledgerRevisions).toEqual([1, 2, 3, 4])
    expect(response.result.status).toMatchObject({
      execution: "finished",
      dispatch: "finished",
      cleanup: "complete",
      targetVerified: "verified",
      heldCount: 0,
      dispatchAttempts: 2,
      ledgerRevision: 4,
    })
    expect(response.result.status.acceptedFence).toEqual({ ...generation, counter: 1 })
    await adapter.close()
  })

  test("передаёт готовый Unicode cluster schedule без повторной сегментации", async () => {
    const adapter = new NativeBrokerAdapter({
      adapterInstanceRef: "native-broker-text-fixture",
      bindEvidence: () => ({
        publisher: { publish: async () => { throw new Error("evidence не ожидался") } },
        sourceResponses: { register: () => undefined },
      }),
      host: host(),
      transport: new NativeProcessTransport(fixturePath),
      ledgerSink: {
        persist: async () => { throw new Error("text clusters не используют held-input ledger") },
      },
    })
    await adapter.handshake({
      kind: "handshake",
      protocolVersion: "1",
      requestId: "handshake-text-1",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      runtimeBuildId: "runtime-build-1",
      expectedNativeBuildId: "native-fixture-build-1",
      capabilitySchemaVersion: "1",
    })
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    const response = await adapter.request(
      nativeInputExecutionRequestSchema,
      {
        kind: "request",
        protocolVersion: "1",
        requestId: "input-text-1",
        ...generation,
        deadlineAt,
        intent: "mutation",
        method: "input.execute",
        operation: {
          kind: "native",
          operationId: "operation-text-1",
          clientRequestId: "client-request-text-1",
          clientSessionId: "client-session-text-1",
          principalId: "principal-text-1",
          ...generation,
          inventoryId: "inventory-text-1",
          inventoryRevision: 1,
          target: {
            kind: "window",
            ref: {
              ...generation,
              applicationRef: "application-text-1",
              windowRef: "window-text-1",
            },
          },
          fence: { ...generation, counter: 1 },
          deadlineAt,
        },
        payload: {
          actionDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
          action: {
            kind: "text",
            utf16Units: "Aя👩‍💻é".length,
            clusters: [
              { text: "A", utf16Units: 1, atMs: 0 },
              { text: "я", utf16Units: 1, atMs: 1 },
              { text: "👩‍💻", utf16Units: "👩‍💻".length, atMs: 2 },
              { text: "é", utf16Units: "é".length, atMs: 3 },
            ],
          },
        },
      },
      nativeInputExecutionResponseSchema,
      {
        signal: new AbortController().signal,
        checkpoint: () => undefined,
      },
    )
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.completedSteps).toBe(4)
    expect(response.result.status).toMatchObject({
      execution: "finished",
      dispatch: "finished",
      dispatchAttempts: 4,
      ledgerRevision: 0,
    })
    await adapter.close()
  })
})
