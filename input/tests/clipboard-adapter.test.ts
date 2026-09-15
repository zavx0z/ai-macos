import { describe, expect, test } from "bun:test"
import {
  freezeAdapterHostContext,
  type AdapterServices,
  type ClipboardExecutionContext,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import {
  SystemClipboardAdapter,
  type VersionedClipboardBackend,
} from "../src/clipboard-adapter.ts"
import { MAX_CLIPBOARD_TEXT_BYTES } from "../src/clipboard.ts"

const runtimeEpoch = "runtime:1"
const loginSessionId = "login:1"
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

function fixture(overrides: Partial<VersionedClipboardBackend> = {}) {
  const calls: Array<{ kind: string, text?: string, expected?: number }> = []
  const backend: VersionedClipboardBackend = {
    buildId: "clipboard-build:1",
    async currentVersion() {
      return 7
    },
    async readText() {
      calls.push({ kind: "read" })
      return { text: "секрет из clipboard", changeCount: 7 }
    },
    async writeText(text, expected) {
      calls.push({ kind: "write", text, expected })
      return { changeCount: 8 }
    },
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

describe("C2 clipboard adapter", () => {
  test("read возвращает текст только явному caller вместе с version", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, { kind: "read" })

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "read",
        text: "секрет из clipboard",
        length: 19,
        version: { backendBuildId: "clipboard-build:1", changeCount: 7 },
      },
    })
    expect(value.checkpoints).toEqual(["clipboard.authorize-context", "clipboard.read"])
  })

  test("write передаёт expected changeCount атомарному backend и не возвращает payload", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, {
      kind: "write",
      text: "секрет для записи",
      expectedVersion: { backendBuildId: "clipboard-build:1", changeCount: 7 },
    })

    expect(value.calls).toEqual([{ kind: "write", text: "секрет для записи", expected: 7 }])
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "write",
        version: { backendBuildId: "clipboard-build:1", changeCount: 8 },
      },
      outcome: { dispatch: "finished", cleanup: { state: "complete" } },
    })
    expect(JSON.stringify(result)).not.toContain("секрет для записи")
  })

  test("отклоняет oversized payload до backend", async () => {
    const value = fixture()
    const result = await value.adapter.execute(value.context, {
      kind: "write",
      text: "x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1),
    })

    expect(result).toMatchObject({ ok: false, outcome: { dispatch: "none", cleanup: { state: "complete" } } })
    expect(value.calls).toEqual([])
  })

  test("неизвестный write outcome quarantines lease без утечки текста", async () => {
    const value = fixture({
      async writeText(text) {
        throw new Error(`backend disconnected while writing ${text}`)
      },
    })
    const result = await value.adapter.execute(value.context, { kind: "write", text: "не логировать это" })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-outcome-unknown", replayAllowed: false },
      outcome: { dispatch: "unknown", cleanup: { state: "unknown" } },
    })
    expect(JSON.stringify(result)).not.toContain("не логировать это")
  })

  test("currentVersion использует отдельный explicit API", async () => {
    const value = fixture()
    await expect(value.adapter.currentVersion(value.context)).resolves.toEqual({
      backendBuildId: "clipboard-build:1",
      changeCount: 7,
    })
  })
})
