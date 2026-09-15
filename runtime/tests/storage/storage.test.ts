import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupAuthorityReceiptSchema,
  heldInputLedgerDigest,
  operationRecordSchema,
  runtimeResourceHandleSchema,
  type HeldInputLedgerSnapshot,
  type OperationRecord,
} from "@meta/shared/contracts"
import {
  FileHeldInputLedger,
  FileOperationJournal,
  type DurableWriteStage,
} from "../../src/storage/index.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

async function temporaryDirectory(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `meta-storage-${name}-`))
  directories.push(path)
  return path
}

function operationRecord(state: "registered" | "dispatching" | "completed" = "registered") {
  return operationRecordSchema.parse({
    clientSessionId: "client:1",
    principalId: "principal:1",
    intent: "read",
    context: {
      kind: "browser",
      operationId: "operation:1",
      clientRequestId: "request:1",
      clientSessionId: "client:1",
      principalId: "principal:1",
      runtimeEpoch: "runtime:1",
      loginSessionId: "login:1",
      inventoryId: "inventory:1",
      inventoryRevision: 1,
      deadlineAt: "2026-09-15T10:00:10.000Z",
      target: {
        kind: "browser-target",
        ref: {
          runtimeEpoch: "runtime:1",
          loginSessionId: "login:1",
          browserInstanceRef: "browser:1",
          transportGeneration: "transport:1",
          targetId: "target:1",
          resourceRef: "resource:1",
        },
      },
    },
    state,
    outcome: {
      dispatch: "none",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: { scope: "none", state: "complete", resources: [] },
      restoration: "not-applicable",
      dispatchAttempts: 0,
    },
    resources: [],
    payloadReceipt: {
      keyGeneration: "hmac:1",
      hmacSha256: "a".repeat(64),
    },
    registeredAt: "2026-09-15T10:00:00.000Z",
    updatedAt: state === "registered"
      ? "2026-09-15T10:00:00.000Z"
      : state === "dispatching"
        ? "2026-09-15T10:00:01.000Z"
        : "2026-09-15T10:00:02.000Z",
  })
}

function ledger(
  revision = 1,
  state: "pending-down" | "confirmed-down" = "pending-down",
  previousSnapshotSha256?: string,
): HeldInputLedgerSnapshot {
  return {
    canonicalVersion: "1",
    operationId: "operation:1",
    runtimeEpoch: "runtime:1",
    loginSessionId: "login:1",
    nativeGeneration: "native:1",
    revision,
    ...(previousSnapshotSha256 === undefined ? {} : { previousSnapshotSha256 }),
    entries: [{ sequence: 1, kind: "key", code: 36, state }],
  }
}

function interruptedRecord(cleanupComplete = false): OperationRecord {
  const base = operationRecord("dispatching")
  const handle = runtimeResourceHandleSchema.parse({
    kind: "cdp-target",
    resourceRef: "resource:1",
    leaseId: "lease:1",
    leaseGeneration: "lease-generation:1",
    operationId: base.context.operationId,
    clientSessionId: base.clientSessionId,
    principalId: base.principalId,
    runtimeEpoch: base.context.runtimeEpoch,
    loginSessionId: base.context.loginSessionId,
    expiresAt: "2026-09-15T10:01:00.000Z",
    state: "quarantined",
  })
  return operationRecordSchema.parse({
    ...base,
    state: "interrupted-unknown",
    outcome: {
      dispatch: "unknown",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: cleanupComplete
        ? {
            scope: "owned",
            state: "complete",
            resources: [{ handle, outcome: "released" }],
          }
        : {
            scope: "owned",
            state: "unknown",
            resources: [{ handle, outcome: "quarantined" }],
            reason: "native reply потерян",
          },
      restoration: "unknown",
      lastCheckpoint: "native-response",
      dispatchAttempts: 1,
      ledgerRevision: 2,
    },
    resources: [handle],
    error: {
      code: "operation-outcome-unknown",
      message: "delivery неизвестна",
      stage: "native-response",
      retryable: false,
      replayAllowed: false,
      recoveryAction: "get-operation",
    },
    updatedAt: cleanupComplete
      ? "2026-09-15T10:00:04.000Z"
      : "2026-09-15T10:00:03.000Z",
  })
}

describe("persistent operation journal", () => {
  test("переживает restart и возвращает unfinished record только как evidence", async () => {
    const root = await temporaryDirectory("journal-restart")
    const directory = join(root, "journal")
    const first = new FileOperationJournal(directory)
    const stored = await first.persist(operationRecord(), 1)
    expect(stored.record.context.operationId).toBe("operation:1")

    const second = new FileOperationJournal(directory)
    const evidence = await second.loadRecoveryEvidence()
    expect(evidence).toEqual([{ revision: 1, record: operationRecord() }])
    expect(evidence[0]?.record.state).toBe("registered")
    expect(JSON.stringify(evidence)).not.toContain("request payload")
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const [file] = await readdir(directory)
    expect(file).toMatch(/^[a-f0-9]{64}\.json$/)
    expect((await stat(join(directory, file!))).mode & 0o777).toBe(0o600)
  })

  test("loadAll возвращает terminal и unfinished metadata без replay", async () => {
    const root = await temporaryDirectory("journal-load-all")
    const directory = join(root, "journal")
    const store = new FileOperationJournal(directory)
    const terminal = operationRecord("completed")
    const unfinished = operationRecordSchema.parse({
      ...operationRecord(),
      context: {
        ...operationRecord().context,
        operationId: "operation:2",
        clientRequestId: "request:2",
      },
    })
    await store.persist(terminal, 4)
    await store.persist(unfinished, 2)

    const all = (await new FileOperationJournal(directory).loadAll())
      .sort((left, right) => {
        return left.record.context.operationId.localeCompare(
          right.record.context.operationId,
        )
      })
    expect(all).toEqual([
      { revision: 4, record: terminal },
      { revision: 2, record: unfinished },
    ])
    expect(await new FileOperationJournal(directory).loadRecoveryEvidence()).toEqual([
      { revision: 2, record: unfinished },
    ])
  })

  test("монотонно обновляет revision, повторяет identical и отклоняет conflict", async () => {
    const root = await temporaryDirectory("journal-revision")
    const store = new FileOperationJournal(join(root, "journal"))
    const first = operationRecord()
    await store.persist(first, 1)
    await expect(store.persist(first, 1)).resolves.toEqual({ revision: 1, record: first })
    await expect(store.persist(operationRecord("dispatching"), 1)).rejects.toThrow("conflicting")
    const progressed = operationRecordSchema.parse({
      ...operationRecord("dispatching"),
      outcome: {
        ...operationRecord("dispatching").outcome,
        dispatch: "attempted",
        dispatchAttempts: 2,
        ledgerRevision: 3,
      },
    })
    await expect(store.persist(progressed, 2)).resolves.toMatchObject({
      revision: 2,
      record: { state: "dispatching" },
    })
    await expect(store.persist({
      ...progressed,
      outcome: { ...progressed.outcome, dispatchAttempts: 1 },
    }, 3)).rejects.toThrow("dispatchAttempts")
    await expect(store.persist({
      ...progressed,
      outcome: { ...progressed.outcome, ledgerRevision: 2 },
    }, 3)).rejects.toThrow("ledgerRevision")
    await expect(store.persist(first, 1)).rejects.toThrow("ниже durable")
    await expect(store.persist({
      ...operationRecord("dispatching"),
      principalId: "principal:other",
      context: {
        ...operationRecord("dispatching").context,
        principalId: "principal:other",
      },
    }, 3)).rejects.toThrow("immutable operation authority")
    await expect(store.persist(operationRecord(), 3)).rejects.toThrow("state machine")

    const secondRoot = await temporaryDirectory("journal-skipped-state")
    const skipped = new FileOperationJournal(join(secondRoot, "journal"))
    await skipped.persist(operationRecord(), 1)
    await expect(skipped.persist(operationRecord("completed"), 2)).resolves.toMatchObject({
      revision: 2,
      record: { state: "completed" },
    })
  })

  test("before/after write failure сохраняет предыдущую durable revision", async () => {
    for (const stage of ["before-write", "after-write"] satisfies DurableWriteStage[]) {
      const root = await temporaryDirectory(`journal-fault-${stage}`)
      const directory = join(root, "journal")
      await new FileOperationJournal(directory).persist(operationRecord(), 1)
      const failing = new FileOperationJournal(directory, {
        failpoint(current) {
          if (current === stage) throw new Error(`injected ${stage}`)
        },
      })
      await expect(failing.persist(operationRecord("dispatching"), 2)).rejects.toThrow(stage)
      const recovered = await new FileOperationJournal(directory).loadRecoveryEvidence()
      expect(recovered).toEqual([{ revision: 1, record: operationRecord() }])
      expect((await readdir(directory)).some(name => name.endsWith(".tmp"))).toBe(false)
    }
  })

  test("после rename без directory sync identical retry подтверждает запись заново", async () => {
    const root = await temporaryDirectory("journal-after-rename")
    const directory = join(root, "journal")
    await new FileOperationJournal(directory).persist(operationRecord(), 1)
    const second = operationRecord("dispatching")
    const failing = new FileOperationJournal(directory, {
      failpoint(stage) {
        if (stage === "after-rename") throw new Error("injected after-rename")
      },
    })
    await expect(failing.persist(second, 2)).rejects.toThrow("after-rename")
    await chmod(directory, 0o755)

    const retry = new FileOperationJournal(directory)
    await expect(retry.persist(second, 2)).resolves.toEqual({
      revision: 2,
      record: second,
    })
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await retry.loadRecoveryEvidence()).toEqual([{ revision: 2, record: second }])
  })

  test("не откатывает terminal facts и принимает correlated cleanup reconciliation", async () => {
    const root = await temporaryDirectory("journal-terminal")
    const store = new FileOperationJournal(join(root, "journal"))
    const unknown = interruptedRecord()
    await store.persist(unknown, 1)
    await expect(store.persist({
      ...unknown,
      outcome: {
        ...unknown.outcome,
        dispatch: "partial",
        dispatchAttempts: 2,
      },
      updatedAt: "2026-09-15T10:00:04.000Z",
    }, 2)).rejects.toThrow("terminal outcome facts")

    const complete = interruptedRecord(true)
    await expect(store.persist(complete, 2)).rejects.toThrow("authority receipt")
    const handle = complete.resources[0]!
    const receipt = cleanupAuthorityReceiptSchema.parse({
      receiptId: "cleanup-receipt:1",
      authorityRef: "cleanup-authority:1",
      operationId: complete.context.operationId,
      runtimeEpoch: complete.context.runtimeEpoch,
      loginSessionId: complete.context.loginSessionId,
      issuedAt: "2026-09-15T10:00:04.000Z",
      state: "complete",
      leases: [{
        leaseId: handle.leaseId,
        leaseGeneration: handle.leaseGeneration,
      }],
    })
    await expect(store.persist(complete, 2, { cleanupReceipt: receipt })).resolves.toEqual({
      revision: 2,
      record: complete,
    })
  })

  test("создаёт missing directory chain с private mode и не меняет ancestor", async () => {
    const root = await temporaryDirectory("journal-directory")
    await chmod(root, 0o750)
    const directory = join(root, "nested", "journal")
    await new FileOperationJournal(directory).persist(operationRecord(), 1)
    expect((await stat(root)).mode & 0o777).toBe(0o750)
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  })

  test("отклоняет truncated, corrupt checksum и небезопасный mode без silent discard", async () => {
    const root = await temporaryDirectory("journal-corrupt")
    const directory = join(root, "journal")
    const store = new FileOperationJournal(directory)
    await store.persist(operationRecord(), 1)
    const [name] = await readdir(directory)
    const path = join(directory, name!)
    const original = await readFile(path, "utf8")
    await writeFile(path, original.slice(0, Math.floor(original.length / 2)), { mode: 0o600 })
    await expect(store.loadRecoveryEvidence()).rejects.toThrow()

    await writeFile(path, original.replace(/"checksum":"[a-f0-9]{64}"/, `"checksum":"${"f".repeat(64)}"`), { mode: 0o600 })
    await expect(store.loadRecoveryEvidence()).rejects.toThrow("checksum")
    await chmod(path, 0o644)
    await expect(store.loadRecoveryEvidence()).rejects.toThrow("mode")
  })
})

describe("persistent held input ledger", () => {
  test("ACK выдаётся после durable write и новый instance читает exact snapshot", async () => {
    const root = await temporaryDirectory("ledger-restart")
    const directory = join(root, "held-ledger")
    const snapshot = ledger()
    const first = new FileHeldInputLedger(directory, {
      now: () => new Date("2026-09-15T10:00:00.000Z"),
    })
    const ack = await first.persist("ledger-request:1", snapshot)
    expect(ack).toMatchObject({
      requestId: "ledger-request:1",
      revision: 1,
      snapshotSha256: heldInputLedgerDigest(snapshot),
      durable: true,
    })

    const second = new FileHeldInputLedger(directory)
    expect(await second.loadAll()).toEqual([{ snapshot, ack }])
  })

  test("lost ACK retry idempotent, conflict отвергается, transition проверяется", async () => {
    const root = await temporaryDirectory("ledger-lost-ack")
    const directory = join(root, "held-ledger")
    let loseAck = true
    const first = ledger()
    const store = new FileHeldInputLedger(directory, {
      now: () => new Date("2026-09-15T10:00:00.000Z"),
      failpoint(stage) {
        if (stage === "after-directory-sync" && loseAck) {
          loseAck = false
          throw new Error("injected lost ACK")
        }
      },
    })
    await expect(store.persist("ledger-request:1", first)).rejects.toThrow("lost ACK")
    const retry = await store.persist("ledger-request:2", first)
    expect(retry).toMatchObject({
      requestId: "ledger-request:2",
      revision: 1,
      snapshotSha256: heldInputLedgerDigest(first),
    })
    await expect(store.persist("ledger-request:3", {
      ...first,
      entries: [{ ...first.entries[0]!, code: 37 }],
    })).rejects.toThrow("conflicting")

    const second = ledger(2, "confirmed-down", retry.snapshotSha256)
    await expect(store.persist("ledger-request:4", second)).resolves.toMatchObject({
      revision: 2,
      snapshotSha256: heldInputLedgerDigest(second),
    })
    await expect(store.persist("ledger-request:5", first)).rejects.toThrow("ниже durable")
  })

  test("write fault не создаёт ACK и не меняет durable snapshot", async () => {
    const root = await temporaryDirectory("ledger-fault")
    const directory = join(root, "held-ledger")
    const first = ledger()
    const initial = new FileHeldInputLedger(directory)
    const firstAck = await initial.persist("ledger-request:1", first)
    const second = ledger(2, "confirmed-down", firstAck.snapshotSha256)
    const failing = new FileHeldInputLedger(directory, {
      failpoint(stage) {
        if (stage === "after-write") throw new Error("injected after-write")
      },
    })
    await expect(failing.persist("ledger-request:2", second)).rejects.toThrow("after-write")
    expect(await new FileHeldInputLedger(directory).loadAll()).toEqual([{
      snapshot: first,
      ack: firstAck,
    }])
  })

  test("после rename без directory sync identical retry подтверждает snapshot заново", async () => {
    const root = await temporaryDirectory("ledger-after-rename")
    const directory = join(root, "held-ledger")
    const first = ledger()
    const firstAck = await new FileHeldInputLedger(directory).persist(
      "ledger-request:1",
      first,
    )
    const second = ledger(2, "confirmed-down", firstAck.snapshotSha256)
    const failing = new FileHeldInputLedger(directory, {
      failpoint(stage) {
        if (stage === "after-rename") throw new Error("injected after-rename")
      },
    })
    await expect(failing.persist("ledger-request:2", second)).rejects.toThrow("after-rename")

    const retry = new FileHeldInputLedger(directory)
    const ack = await retry.persist("ledger-request:3", second)
    expect(ack).toMatchObject({
      requestId: "ledger-request:3",
      revision: 2,
      snapshotSha256: heldInputLedgerDigest(second),
      durable: true,
    })
    expect((await retry.loadAll())[0]?.snapshot).toEqual(second)
  })
})
