import { describe, expect, test } from "bun:test"
import {
  freezeAdapterHostContext,
  type AdapterServices,
  type ClipboardExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  SystemClipboardAdapter,
} from "../src/clipboard-adapter.ts"
import {
  ClipboardBackendError,
  clipboardBackendReportSchema,
  type ClipboardBackendReport,
  type VersionedClipboardBackend,
} from "../src/native-clipboard-backend.ts"

const runtimeEpoch = "runtime:1"
const loginSessionId = "login:1"
const nativeGeneration = "native:1"
const deadlineAt = "2026-09-15T10:01:00.000Z"
const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:1",
  capabilities: {
    schemaVersion: "1",
    scope: "adapter",
    producerRef: "clipboard-adapter:1",
    capabilities: [{ id: "input.clipboard", state: "ready" }],
  },
})
const session = {
  clientSessionId: "client:1",
  principalId: "principal:1",
  runtimeEpoch,
  loginSessionId,
  authenticationGeneration: "auth:1",
  authenticatedAt: "2026-09-15T09:59:00.000Z",
  expiresAt: "2026-09-15T10:10:00.000Z",
}
const wire: ClipboardExecutionContext = {
  kind: "clipboard",
  operationId: "operation:clipboard",
  clientRequestId: "request:clipboard",
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  inventoryId: "inventory:clipboard",
  inventoryRevision: 1,
  deadlineAt,
  target: {
    kind: "clipboard",
    ref: { runtimeEpoch, loginSessionId, clipboardRef: "system" },
  },
}
const resource = {
  kind: "clipboard",
  resourceRef: "system",
  leaseId: "lease:clipboard",
  leaseGeneration: "lease-generation:1",
  operationId: wire.operationId,
  clientSessionId: session.clientSessionId,
  principalId: session.principalId,
  runtimeEpoch,
  loginSessionId,
  expiresAt: deadlineAt,
  state: "active",
} as const

function report(
  command: ClipboardBackendReport["command"],
  status: ClipboardBackendReport["status"],
  metadata: Partial<ClipboardBackendReport> = {},
): ClipboardBackendReport {
  return clipboardBackendReportSchema.parse({
    authority: "verified-response",
    command,
    status,
    receipt: {
      receiptId: `receipt:${command}:${status}`,
      adapterInstanceRef: "native-adapter:1",
      backendBuildId: "native-build:1",
      requestId: `native-request:${command}:${status}`,
      operationId: wire.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
    },
    mutationAttempted: command === "clipboard.write" ? "true" : "false",
    atomicPrecondition: false,
    ...metadata,
  })
}

function fixture(overrides: Partial<VersionedClipboardBackend> = {}) {
  const calls: Array<{ kind: string, text?: string, expected?: number }> = []
  const backend: VersionedClipboardBackend = {
    buildId: "native-build:1",
    async currentVersion() {
      return {
        value: { status: "ok", changeCount: 7 },
        report: report("clipboard.version", "ok", { changeCount: 7 }),
      }
    },
    async readText() {
      calls.push({ kind: "read" })
      return {
        value: {
          status: "ok",
          text: "секрет из clipboard",
          utf8Bytes: 27,
          beforeChangeCount: 7,
          afterChangeCount: 7,
        },
        report: report("clipboard.read", "ok", {
          beforeChangeCount: 7,
          afterChangeCount: 7,
          utf8Bytes: 27,
        }),
      }
    },
    async conditionalWrite(_context, text, expected) {
      calls.push({ kind: "write", text, expected })
      return {
        value: {
          status: "written",
          beforeChangeCount: 7,
          declaredChangeCount: 8,
          afterChangeCount: 8,
          mutationAttempted: true,
          setStringSucceeded: true,
          ownershipStableAfterWrite: true,
          atomicPrecondition: false,
          utf8Bytes: new TextEncoder().encode(text).byteLength,
        },
        report: report("clipboard.write", "written", {
          beforeChangeCount: 7,
          declaredChangeCount: 8,
          afterChangeCount: 8,
          mutationAttempted: "true",
          setStringSucceeded: true,
          ownershipStableAfterWrite: true,
          utf8Bytes: new TextEncoder().encode(text).byteLength,
        }),
      }
    },
    async verifyReport() {},
    ...overrides,
  }
  const checkpoints: string[] = []
  const context: RuntimeOperationContext<ClipboardExecutionContext> = {
    wire,
    session,
    resources: [resource],
    control: {
      signal: new AbortController().signal,
      checkpoint(stage) {
        checkpoints.push(stage)
      },
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
          resolutionId: "resolution:1",
          proofRef: "proof:1",
          inventoryId: request.inventoryId,
          inventoryRevision: request.inventoryRevision,
          displayLayoutRevision: 0,
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
    observations: { async resolvePoint() { throw new Error("не используется") } },
    continuations: {
      async issue() { throw new Error("не используется") },
      async registerAcceptedTask() { throw new Error("не используется") },
      async advanceVerifiedStatus() { throw new Error("не используется") },
      async markVerifiedTerminal() { throw new Error("не используется") },
    },
    reservations: { async assertChild() { throw new Error("не используется") } },
  }
  return {
    adapter: new SystemClipboardAdapter(host, services, backend, () => new Date("2026-09-15T10:00:00.000Z")),
    backend,
    calls,
    checkpoints,
    context,
  }
}

describe("C3 clipboard adapter", () => {
  test("explicit read возвращает coherent text и metadata-only report", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, { kind: "read" })

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "read",
        status: "ok",
        text: "секрет из clipboard",
        version: { backendBuildId: "native-build:1", changeCount: 7 },
      },
      outcome: { cleanup: { state: "pending" } },
      clipboard: { authority: "verified-response", status: "ok" },
    })
    expect(JSON.stringify(result.clipboard)).not.toContain("секрет из clipboard")
  })

  test("written сохраняет measured counts и не обещает CAS", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, {
      kind: "write",
      text: "секрет для записи",
      expectedVersion: { backendBuildId: "native-build:1", changeCount: 7 },
    })

    expect(value.calls).toEqual([{ kind: "write", text: "секрет для записи", expected: 7 }])
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "write",
        status: "written",
        beforeChangeCount: 7,
        declaredChangeCount: 8,
        afterChangeCount: 8,
        atomicPrecondition: false,
      },
      outcome: { dispatch: "finished", cleanup: { state: "pending" } },
      clipboard: { status: "written", atomicPrecondition: false },
    })
    expect(JSON.stringify(result)).not.toContain("секрет для записи")
  })

  test("precondition mismatch не исполняется и запрещает automatic replay", async () => {
    const mismatch = report("clipboard.write", "precondition-mismatch-no-dispatch", {
      beforeChangeCount: 8,
      mutationAttempted: "false",
    })
    const value = fixture({
      async conditionalWrite() {
        return {
          value: {
            status: "precondition-mismatch-no-dispatch",
            beforeChangeCount: 8,
            mutationAttempted: false,
            atomicPrecondition: false,
          },
          report: mismatch,
        }
      },
    })
    const result = await value.adapter.execute(value.context, {
      kind: "write",
      text: "new",
      expectedVersion: { backendBuildId: "native-build:1", changeCount: 7 },
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "target-stale", retryable: true, replayAllowed: false },
      outcome: { dispatch: "none", cleanup: { state: "pending" } },
      clipboard: { mutationAttempted: "false" },
    })
  })

  test("partial write остаётся unknown и не раскрывает payload", async () => {
    const partial = report("clipboard.write", "partial-or-unknown", {
      beforeChangeCount: 7,
      mutationAttempted: "true",
      setStringSucceeded: false,
      ownershipStableAfterWrite: false,
      utf8Bytes: 27,
    })
    const value = fixture({
      async conditionalWrite() {
        return {
          value: {
            status: "partial-or-unknown",
            beforeChangeCount: 7,
            mutationAttempted: true,
            setStringSucceeded: false,
            ownershipStableAfterWrite: false,
            atomicPrecondition: false,
            utf8Bytes: 27,
          },
          report: partial,
        }
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "write", text: "не логировать это" })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown", replayAllowed: false },
      outcome: { dispatch: "unknown", cleanup: { state: "pending" } },
      clipboard: { status: "partial-or-unknown" },
    })
    expect(JSON.stringify(result)).not.toContain("не логировать это")
  })

  test("lost reply остаётся unverified и удерживает lease", async () => {
    const unavailable = clipboardBackendReportSchema.parse({
      authority: "unverified-request",
      command: "clipboard.write",
      status: "response-unavailable",
      requestId: "native-request:lost",
      mutationAttempted: "unknown",
      atomicPrecondition: false,
    })
    const value = fixture({
      async conditionalWrite() {
        throw new ClipboardBackendError("lost", undefined, unavailable)
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "write", text: "секрет lost reply" })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown", replayAllowed: false },
      outcome: { cleanup: { state: "pending" } },
      clipboard: { authority: "unverified-request", mutationAttempted: "unknown" },
    })
    expect(JSON.stringify(result)).not.toContain("секрет lost reply")
  })

  test("text unavailable отличается от пустой строки", async () => {
    const value = fixture({
      async readText() {
        return {
          value: { status: "text-unavailable", beforeChangeCount: 9, afterChangeCount: 9 },
          report: report("clipboard.read", "text-unavailable", {
            beforeChangeCount: 9,
            afterChangeCount: 9,
          }),
        }
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "read" })

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "read", status: "text-unavailable", version: { changeCount: 9 } },
    })
    expect(result.ok && "text" in result.value).toBe(false)
  })

  test("currentVersion использует тот же ClipboardExecutionContext", async () => {
    const value = fixture()
    await expect(value.adapter.currentVersion(value.context)).resolves.toEqual({
      backendBuildId: "native-build:1",
      changeCount: 7,
    })
  })
})
