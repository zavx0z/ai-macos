import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { nativeHandshakeResponseSchema, heldInputLedgerDigest, runtimeOperationIntentSchema, type NativeAdapter } from "@meta/shared/contracts"
import type { NativeHeldRecoveryRequest, NativeHeldRecoveryResponse } from "@meta/native/protocol"
import { RuntimeCore } from "../src/core.ts"
import { FileHeldInputLedger, FileOperationJournal } from "../src/storage/index.ts"
import { NativeActorJournal } from "../src/native-actor.ts"
import { StartupHeldRecovery } from "../src/startup-held-recovery.ts"

test("restart recovery оставляет ledger immutable, held блокирует, all-up с actor exit снимает только cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "startup-held-"))
  const loginSessionId = "login:startup-held"
  const journal = new FileOperationJournal(join(directory, "operations"))
  const ledgers = new FileHeldInputLedger(join(directory, "held"))
  let actorAbsent = false
  let held = true
  let probes = 0
  const actors = new NativeActorJournal(join(directory, "actors"), loginSessionId, { absent: () => actorAbsent })
  const oldGeneration = { runtimeEpoch: "runtime:old-held", loginSessionId }
  const oldNative = "native:old-held"
  const old = new RuntimeCore({ generation: oldGeneration, runtimeBuildId: "build:held", nativeGeneration: oldNative,
    native: {} as NativeAdapter, operationJournal: journal, nativeRecovery: { policyVersion: "1", nativeBuildId: "build:held" } })
  await old.initializeRecovery()
  const credential = old.openClient("principal:held")
  const target = { kind: "display" as const, ref: { ...oldGeneration, nativeGeneration: oldNative, displayRef: "display:held", displayLayoutRevision: 0 } }
  old.targets.register(target, "inventory:held", 0, "resolution:held", "proof:held", 0)
  try {
    const interrupted = await old.runOperation(credential.session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:held",
      precondition: { target, inventoryId: "inventory:held", inventoryRevision: 0 }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
      requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    }), {}, async context => {
      if (context.wire.kind !== "native") throw new Error("Native context expected")
      await old.authorizeNativeMutation(context.wire, { policyVersion: "1", nativeBuildId: "build:held", method: "input.execute",
        domain: "possible-held-input", possibleHolds: [{ kind: "key", code: 56 }] })
      throw new Error("injected crash boundary")
    })
    const operationId = interrupted.operation.context.operationId
    await ledgers.persist("ledger:old", { canonicalVersion: "1", ...oldGeneration, nativeGeneration: oldNative,
      operationId, revision: 1, entries: [{ sequence: 1, kind: "key", code: 56, state: "pending-down" }] })
    const originalLedger = JSON.stringify(await ledgers.loadAll())
    await actors.register(nativeHandshakeResponseSchema.parse({ kind: "handshake-response", protocolVersion: "1", requestId: "handshake:held",
      ...oldGeneration, nativeGeneration: oldNative, nativeBuildId: "build:held", recoveryDomainVersion: "1", capabilitySchemaVersion: "1", installRoot: "/tmp/held-fixture",
      process: { pid: 100, startedAt: new Date().toISOString(), nonce: "nonce:held" },
      session: { verified: true, source: "darwin-audit", uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 1 },
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "native:held", capabilities: [] },
    }), "/tmp/held-fixture/helper")
    const generation = { runtimeEpoch: "runtime:new-held", loginSessionId }
    const native = {
      generation: { ...generation, nativeGeneration: "native:new-held" }, loadedBuildId: "build:held",
      async heldRecovery(request: NativeHeldRecoveryRequest): Promise<NativeHeldRecoveryResponse> {
        probes++
        return { kind: "held-recovery-response", protocolVersion: "1", requestId: request.requestId, ...this.generation,
          nativeBuildId: this.loadedBuildId, oldOperationId: request.ledger.operationId, oldRuntimeEpoch: request.ledger.runtimeEpoch,
          oldNativeGeneration: request.ledger.nativeGeneration, ledgerRevision: request.ledger.revision, ledgerSha256: heldInputLedgerDigest(request.ledger),
          sampledAt: new Date().toISOString(), inputMonitoring: true, observerReady: true, sessionState: "active-console", lockState: "unknown", secureInput: "off",
          source: "cg-combined-session-state", entries: request.ledger.entries.filter(entry => entry.state !== "released").map(entry => ({
            sequence: entry.sequence, kind: entry.kind, code: entry.code, observed: held ? "held" : "up",
          })) }
      },
    }
    const recovery = new StartupHeldRecovery({ directory: join(directory, "recovery"), generation, ledgers, actors, native })
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:held", operationJournal: journal, startupRecovery: recovery,
      clientPersistence: { sessions: old.clients.snapshot(), async persist() {} } })
    await core.initializeRecovery()
    expect(core.admissionSealed).toBe(true)
    expect((await recovery.recover(operationId)).resolved).toBe(0)
    expect(probes).toBe(0)
    actorAbsent = true
    expect((await recovery.recover(operationId)).unresolved).toBe(1)
    held = false
    expect(await recovery.recover(operationId)).toEqual({ resolved: 1, unresolved: 0 })
    await core.refreshStartupRecovery(true)
    expect(core.admissionSealed).toBe(false)
    const resumed = await core.resumeClientDurable(credential.resumptionToken)
    const record = await core.getOperation(resumed.session, operationId)
    expect(record?.outcome.cleanup.state).toBe("complete")
    expect(record?.outcome.effect).toEqual(interrupted.operation.outcome.effect)
    expect(record?.state).toBe("interrupted-unknown")
    expect(JSON.stringify(await ledgers.loadAll())).toBe(originalLedger)
    const reloaded = new RuntimeCore({ generation: { runtimeEpoch: "runtime:third-held", loginSessionId }, runtimeBuildId: "build:held",
      operationJournal: journal, startupRecovery: recovery })
    await reloaded.initializeRecovery()
    expect(reloaded.admissionSealed).toBe(false)
    expect(probes).toBe(2)
    await core.closeClientLifecycle()
    await reloaded.closeClientLifecycle()
  } finally {
    await old.closeClientLifecycle()
    await rm(directory, { recursive: true, force: true })
  }
})
