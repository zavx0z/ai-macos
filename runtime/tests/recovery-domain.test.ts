import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeHandshakeResponseSchema, runtimeOperationIntentSchema, type NativeAdapter } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { FileOperationJournal, FileHeldInputLedger } from "../src/storage/index.ts"
import { NativeActorJournal } from "../src/native-actor.ts"
import { StartupHeldRecovery } from "../src/startup-held-recovery.ts"

for (const phase of ["registered", "authorized"] as const) {
  test(`durable ${phase} survives process crash и даёт положительный no-ledger recovery`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "domain-crash-"))
    const operations = join(directory, "operations")
    const child = Bun.spawn([Bun.which("bun")!, new URL("./fixtures/recovery-domain-crash.ts", import.meta.url).pathname, operations, phase], { stdout: "pipe", stderr: "pipe" })
    try {
      expect(await child.exited).toBe(0)
      const operationId = await new Response(child.stdout).text()
      const store = new FileOperationJournal(operations)
      const [before] = await store.loadAll()
      expect(before?.record.nativeRecovery?.phase).toBe(phase === "registered" ? "not-authorized" : "send-authorized")
      expect(JSON.stringify(before)).not.toContain("не должен сохраняться")
      let absent = false
      const actors = new NativeActorJournal(join(directory, "actors"), "login:domain-crash", { absent: () => absent })
      await actors.register(nativeHandshakeResponseSchema.parse({ kind: "handshake-response", protocolVersion: "1", requestId: "hs:domain",
        runtimeEpoch: "runtime:domain-crash", loginSessionId: "login:domain-crash", nativeGeneration: "native:domain-crash",
        nativeBuildId: "native-build:domain-crash", recoveryDomainVersion: "1", capabilitySchemaVersion: "1", installRoot: "/tmp/domain-fixture",
        process: { pid: child.pid, startedAt: new Date().toISOString(), nonce: "nonce:domain" },
        session: { verified: true, source: "darwin-audit", uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 1 },
        capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "native:domain", capabilities: [] },
      }), "/tmp/domain-fixture/helper")
      const generation = { runtimeEpoch: "runtime:domain-restart", loginSessionId: "login:domain-crash" }
      const recovery = new StartupHeldRecovery({ directory: join(directory, "recovery"), generation, actors,
        ledgers: new FileHeldInputLedger(join(directory, "held")) })
      const core = new RuntimeCore({ generation, runtimeBuildId: "build:restart", operationJournal: store, startupRecovery: recovery })
      await core.initializeRecovery()
      expect(core.admissionSealed).toBe(phase === "authorized")
      absent = true
      await core.refreshStartupRecovery(true)
      const after = await store.read({ runtimeEpoch: "runtime:domain-crash", loginSessionId: "login:domain-crash", operationId })
      expect(core.admissionSealed).toBe(false)
      expect(after?.record.outcome.cleanup.state).toBe("complete")
      expect(after?.record.outcome.effect).toEqual(before?.record.outcome.effect)
      if (phase === "authorized") expect(after?.record.outcome.restoration).toBe("unknown")
      if (before?.record.nativeRecovery?.phase === "send-authorized") {
        await expect(store.persist({ ...after!.record, nativeRecovery: { phase: "not-authorized", policyVersion: "1",
          nativeBuildId: "native-build:domain-crash", nativeGeneration: "native:domain-crash" } }, after!.revision + 1)).rejects.toThrow("immutable")
      }
      await core.closeClientLifecycle()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("restart retention сохраняет possible-hold quarantine и не доверяет missing marker", async () => {
  for (const protectedGate of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "domain-retain-"))
    const generation = { runtimeEpoch: "runtime:retain", loginSessionId: "login:retain" }
    const core = new RuntimeCore({ generation, runtimeBuildId: "build:retain", native: {} as NativeAdapter, nativeGeneration: "native:retain",
      operationJournal: new FileOperationJournal(directory),
      ...(protectedGate ? { nativeRecovery: { policyVersion: "1" as const, nativeBuildId: "native-build:retain" } } : {}) })
    await core.initializeRecovery()
    const session = core.openClient("principal:retain").session
    const target = { kind: "display" as const, ref: { ...generation, nativeGeneration: "native:retain", displayRef: "display:retain", displayLayoutRevision: 0 } }
    core.targets.register(target, "inventory:retain", 0, "resolution:retain", "proof:retain", 0)
    try {
      const operation = await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:retain",
        precondition: { target, inventoryId: "inventory:retain", inventoryRevision: 0 }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      }), {}, async context => {
        if (protectedGate && context.wire.kind === "native") await core.authorizeNativeMutation(context.wire, {
          policyVersion: "1", nativeBuildId: "native-build:retain", method: "input.execute",
          domain: "possible-held-input", possibleHolds: [{ kind: "key", code: 0 }],
        })
        throw new Error("unknown after possible text down")
      })
      if (protectedGate) {
        expect(await core.retainForRecoveryRestart()).toEqual({ journalDurable: true, operationIds: [operation.operation.context.operationId] })
        expect(core.resources.quarantinedCount()).toBe(1)
        expect((await core.getOperation(session, operation.operation.context.operationId))?.outcome.cleanup.state).toBe("unknown")
      } else {
        await expect(core.retainForRecoveryRestart()).rejects.toThrow("durable native send gate")
      }
    } finally {
      await core.closeClientLifecycle()
      await rm(directory, { recursive: true, force: true })
    }
  }
})
