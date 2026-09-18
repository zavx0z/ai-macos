import { describe, expect, test } from "bun:test"
import {
  DESKTOP_INPUT_RESOURCE_REF,
  assertCleanupOwnsExactHandles,
  adapterResultSchema,
  assertBrowserResultMatchesRequest,
  browserOperationRequestSchema,
  browserOperationResources,
  browserOperationResultSchema,
  cleanupOutcomeSchema,
  cleanupAuthorityReceiptSchema,
  heldInputLedgerAckMatches,
  heldInputLedgerAckSchema,
  heldInputLedgerSnapshotSchema,
  heldInputLedgerDigest,
  nativeCancelAckMatches,
  nativeCancelAckSchema,
  nativeCleanupAckMatches,
  nativeCleanupAckSchema,
  nativeCleanupControlSchema,
  createNativeCleanupRequestSchema,
  nativeCancelRequestSchema,
  nativeOperationStatusSchema,
  nativeStatusMatchesOperation,
  observedEventSchema,
  observerAllowsRestoration,
  observerCoverageSchema,
  operationCanReleaseMutationLease,
  operationRecordSchema,
  requireAuthorizedResourceHandles,
  runtimeOperationIntentSchema,
  runtimeResourceHandleSchema,
  validateLedgerTransition,
  type ResourceAuthority,
  z,
} from "./index.ts"
import {
  browserContext,
  browserTargetRef,
  deadlineAt,
  loginSessionId,
  nativeGeneration,
  nativeContext,
  now,
  resourceHandle,
  runtimeEpoch,
  session,
  readyPolicy,
  readyResult,
  windowRef,
} from "./test-fixtures.ts"

const noCleanup = cleanupOutcomeSchema.parse({ scope: "none", state: "complete", resources: [] })

function outcome(cleanup: unknown = noCleanup) {
  return {
    dispatch: "none",
    targetVerified: "unknown",
    userInterference: "unknown",
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup,
    restoration: "not-applicable",
    dispatchAttempts: 0,
  }
}

function fakeAuthority(revoked = new Set<string>()): ResourceAuthority {
  return {
    async assertActive(request) {
      const handle = request.handle
      if (
        revoked.has(handle.leaseId)
        || handle.state !== "active"
        || handle.operationId !== request.operationId
        || handle.clientSessionId !== request.clientSessionId
        || handle.principalId !== request.principalId
        || handle.runtimeEpoch !== request.runtimeEpoch
        || handle.loginSessionId !== request.loginSessionId
        || request.now.getTime() >= Date.parse(handle.expiresAt)
      ) {
        throw new Error("lease authority rejected")
      }
    },
    async assertOwnedSet(operationId, handles) {
      if (handles.some(handle => handle.operationId !== operationId)) throw new Error("foreign resource")
    },
  }
}

describe("C1 client and resource authority", () => {
  test("operation intent принимает payload, но не caller-provided HMAC", () => {
    const intent = {
      intent: "mutation",
      clientRequestId: "client-request:1",
      precondition: {
        target: { kind: "browser-target", ref: browserTargetRef },
        inventoryId: "browser-inventory:1",
        inventoryRevision: 2,
      },
      deadlineAt,
      requestedResources: [{ kind: "cdp-target", resourceRef: browserTargetRef.resourceRef }],
    }
    expect(runtimeOperationIntentSchema.parse(intent)).not.toHaveProperty("payloadHmac")
    expect(runtimeOperationIntentSchema.safeParse({ ...intent, payloadHmac: "model-proof" }).success).toBe(false)
  })

  test("resource handle структурно связан с client/operation/lease generation, authority проверяет revoke", async () => {
    const handle = runtimeResourceHandleSchema.parse(resourceHandle("cdp-target", browserTargetRef.resourceRef, "operation:browser:1"))
    const owner = {
      operationId: "operation:browser:1",
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      runtimeEpoch,
      loginSessionId,
      now: new Date(now),
    }
    await requireAuthorizedResourceHandles(fakeAuthority(), [handle], owner, [{
      kind: "cdp-target",
      resourceRef: browserTargetRef.resourceRef,
    }])
    await expect(requireAuthorizedResourceHandles(fakeAuthority(new Set([handle.leaseId])), [handle], owner, [{
      kind: "cdp-target",
      resourceRef: browserTargetRef.resourceRef,
    }])).rejects.toThrow("rejected")
    await expect(requireAuthorizedResourceHandles(fakeAuthority(), [{ ...handle, principalId: "principal:foreign" }], owner, [{
      kind: "cdp-target",
      resourceRef: browserTargetRef.resourceRef,
    }])).rejects.toThrow("rejected")
  })

  test("cleanup является точным partition operation-owned handles", async () => {
    const handle = runtimeResourceHandleSchema.parse(resourceHandle("cdp-target", browserTargetRef.resourceRef, "operation:browser:1"))
    const cleanup = cleanupOutcomeSchema.parse({
      scope: "owned",
      state: "complete",
      resources: [{ handle, outcome: "released" }],
    })
    await assertCleanupOwnsExactHandles(fakeAuthority(), "operation:browser:1", [handle], cleanup)
    await expect(assertCleanupOwnsExactHandles(fakeAuthority(), "operation:browser:1", [handle], noCleanup)).rejects.toThrow("потерял")
    expect(cleanupOutcomeSchema.safeParse({
      scope: "owned",
      state: "unknown",
      reason: "native reply lost",
      resources: [],
    }).success).toBe(false)
  })

  test("видимая browser activation всегда требует desktop lease и не принимает caller classification", () => {
    const request = browserOperationRequestSchema.parse({ kind: "activate-visible-target", target: browserTargetRef })
    expect(browserOperationResources(request)).toEqual([
      { kind: "desktop-input", resourceRef: DESKTOP_INPUT_RESOURCE_REF },
      { kind: "cdp-target", resourceRef: browserTargetRef.resourceRef },
    ])
    expect(browserOperationRequestSchema.safeParse({
      kind: "activate-visible-target",
      target: browserTargetRef,
      desktopAffecting: false,
    }).success).toBe(false)
  })

  test("browser result не может подменить target другим instance с тем же URL", () => {
    const request = browserOperationRequestSchema.parse({
      kind: "navigate-target",
      target: browserTargetRef,
      url: "https://example.com",
      policy: readyPolicy,
      timeoutMs: 5_000,
    })
    const result = browserOperationResultSchema.parse({
      value: {
        kind: "target-navigated",
        target: {
          ref: { ...browserTargetRef, browserInstanceRef: "browser:foreign", resourceRef: "foreign-target:1" },
          type: "page",
          title: "Example",
          url: "https://example.com",
        },
        readiness: readyResult,
      },
      cleanup: noCleanup,
    })
    expect(() => assertBrowserResultMatchesRequest(request, result)).toThrow("другой exact target")
  })

  test("DOM/accessibility/console result соблюдает requested representation и byte/count limits", () => {
    const domRequest = browserOperationRequestSchema.parse({ kind: "read-dom", target: browserTargetRef, maxBytes: 1 })
    const wrongRepresentation = browserOperationResultSchema.parse({
      value: {
        kind: "accessibility-read",
        target: browserTargetRef,
        content: "0123456789",
        contentBytes: 10,
        nodeCount: 1,
        truncated: false,
      },
      cleanup: noCleanup,
    })
    expect(() => assertBrowserResultMatchesRequest(domRequest, wrongRepresentation)).toThrow("kind")
    const oversizedDom = browserOperationResultSchema.parse({
      value: { kind: "dom-read", target: browserTargetRef, content: "0123456789", contentBytes: 10, truncated: false },
      cleanup: noCleanup,
    })
    expect(() => assertBrowserResultMatchesRequest(domRequest, oversizedDom)).toThrow("byte budget")

    const consoleRequest = browserOperationRequestSchema.parse({
      kind: "read-console",
      target: browserTargetRef,
      maxEvents: 1,
      maxBytes: 1,
    })
    const entries = [{ level: "log", text: "long", timestamp: now }]
    const consoleResult = browserOperationResultSchema.parse({
      value: {
        kind: "console-read",
        target: browserTargetRef,
        entries,
        serializedBytes: new TextEncoder().encode(JSON.stringify(entries)).byteLength,
        droppedEvents: 0,
        truncated: false,
      },
      cleanup: noCleanup,
    })
    expect(() => assertBrowserResultMatchesRequest(consoleRequest, consoleResult)).toThrow("limits")
  })
})

describe("C1 native lifecycle", () => {
  const firstLedger = heldInputLedgerSnapshotSchema.parse({
    canonicalVersion: "1",
    operationId: "operation:1",
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    revision: 1,
    entries: [{ sequence: 1, kind: "key", code: 36, state: "pending-down" }],
  })

  test("ledger ACK и transition связаны с digest и всеми generations", () => {
    const firstAck = heldInputLedgerAckSchema.parse({
      requestId: "ledger-request:1",
      operationId: firstLedger.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: firstLedger.revision,
      snapshotSha256: heldInputLedgerDigest(firstLedger),
      persistedAt: now,
      durable: true,
    })
    const next = heldInputLedgerSnapshotSchema.parse({
      ...firstLedger,
      revision: 2,
      previousSnapshotSha256: firstAck.snapshotSha256,
      entries: [{ sequence: 1, kind: "key", code: 36, state: "confirmed-down" }],
    })
    validateLedgerTransition(firstLedger, next, firstAck)
    const ack = heldInputLedgerAckSchema.parse({
      requestId: "ledger-request:2",
      operationId: next.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: next.revision,
      snapshotSha256: heldInputLedgerDigest(next),
      persistedAt: now,
      durable: true,
    })
    expect(heldInputLedgerAckMatches("ledger-request:2", next, ack)).toBe(true)
    expect(heldInputLedgerAckMatches("ledger-request:2", next, { ...ack, nativeGeneration: "native:foreign" })).toBe(false)
    expect(() => validateLedgerTransition(firstLedger, { ...next, entries: [{ ...next.entries[0]!, state: "released" }] }, firstAck)).toThrow("Недопустимый")
  })

  test("ledger принимает unchanged held key и новый pending key с monotonic sequence", () => {
    const previous = heldInputLedgerSnapshotSchema.parse({
      canonicalVersion: "1",
      operationId: "operation:two-keys",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 1,
      entries: [{ sequence: 1, kind: "key", code: 55, state: "confirmed-down" }],
    })
    const previousAck = heldInputLedgerAckSchema.parse({
      requestId: "ledger-request:two-keys:1",
      operationId: previous.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      revision: 1,
      snapshotSha256: heldInputLedgerDigest(previous),
      persistedAt: now,
      durable: true,
    })
    const next = heldInputLedgerSnapshotSchema.parse({
      ...previous,
      revision: 2,
      previousSnapshotSha256: previousAck.snapshotSha256,
      entries: [
        ...previous.entries,
        { sequence: 2, kind: "key", code: 56, state: "pending-down" },
      ],
    })
    expect(() => validateLedgerTransition(previous, next, previousAck)).not.toThrow()
    expect(() => validateLedgerTransition(previous, {
      ...next,
      entries: [...previous.entries, { sequence: 1, kind: "key", code: 56, state: "pending-down" }],
    }, previousAck)).toThrow("sequence")
  })

  test("ledger запрещает две active entries одного held key", () => {
    expect(heldInputLedgerSnapshotSchema.safeParse({
      ...firstLedger,
      entries: [
        { sequence: 1, kind: "key", code: 36, state: "pending-down" },
        { sequence: 2, kind: "key", code: 36, state: "confirmed-down" },
      ],
    }).success).toBe(false)
  })

  test("unavailable observer даёт unknown interference, active status содержит reconciliation metadata", () => {
    const status = nativeOperationStatusSchema.parse({
      requestId: "status-request:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      highWaterFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      acceptedFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      operationId: "operation:1",
      execution: "dispatching",
      dispatch: "attempted",
      cleanup: "unknown",
      targetVerified: "verified",
      cancellationRequested: false,
      userInterference: "unknown",
      restorationAllowed: false,
      quarantined: false,
      heldCount: 1,
      lastCheckpoint: "after-down-before-ack",
      dispatchAttempts: 1,
      ledgerRevision: 2,
      observer: {
        state: "unavailable",
        runtimeEpoch,
        loginSessionId,
        nativeGeneration,
        coverageStartCursor: "observer:start:1",
        cursor: "observer:1",
        nextSequence: 3,
        startedAt: "2026-09-15T09:59:00.000Z",
        coveredFrom: "2026-09-15T09:59:00.000Z",
        coveredThrough: "2026-09-15T09:59:59.900Z",
        heartbeatAt: "2026-09-15T10:00:00.000Z",
        coveredKinds: [],
        droppedEvents: 0,
        gapDetected: true,
        reason: "event tap revoked",
      },
    })
    expect(status.lastCheckpoint).toBe("after-down-before-ack")
    expect(nativeStatusMatchesOperation(nativeContext(), status)).toBe(true)
    expect(nativeStatusMatchesOperation(nativeContext(), { ...status, nativeGeneration: "native:foreign" })).toBe(false)
    const resultSchema = adapterResultSchema(z.string())
    expect(resultSchema.parse({
      ok: false,
      error: {
        code: "internal-error",
        message: "native action failed",
        stage: "native-executor",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
      outcome: outcome(),
      nativeStatus: status,
    }).nativeStatus).toEqual(status)
    expect(resultSchema.parse({
      ok: false,
      error: {
        code: "operation-outcome-unknown",
        message: "status unavailable",
        stage: "native-status",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
      outcome: outcome(),
    })).not.toHaveProperty("nativeStatus")
    expect(nativeOperationStatusSchema.safeParse({ ...status, userInterference: "none-observed" }).success).toBe(false)
    expect(observerCoverageSchema.safeParse({ ...status.observer, state: "ready", reason: undefined }).success).toBe(false)
    expect(observedEventSchema.safeParse({
      eventId: "event:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      cursor: "observer:1",
      sequence: 2,
      observedAt: now,
      kind: "focus",
      source: "external-user",
      target: { kind: "window", ref: { ...windowRef, loginSessionId: "login:foreign" } },
    }).success).toBe(false)
  })

  test("observer restore требует current interval/cursor watermark и bounded heartbeat lag", () => {
    const coverage = observerCoverageSchema.parse({
      state: "ready",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      coverageStartCursor: "observer:start:1",
      cursor: "observer:current:1",
      nextSequence: 10,
      startedAt: "2026-09-15T09:59:00.000Z",
      coveredFrom: "2026-09-15T09:59:00.000Z",
      coveredThrough: "2026-09-15T09:59:59.900Z",
      heartbeatAt: "2026-09-15T10:00:00.000Z",
      coveredKinds: ["input", "focus"],
      droppedEvents: 0,
      gapDetected: false,
    })
    const decision = {
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      interactionStartedAt: "2026-09-15T09:59:30.000Z",
      expectedCoverageStartCursor: "observer:start:1",
      now: new Date(now),
      maxLagMs: 250,
    }
    expect(observerAllowsRestoration(coverage, decision)).toBe(true)
    expect(observerAllowsRestoration({
      ...coverage,
      startedAt: "2099-01-01T00:00:00Z",
      coveredFrom: "2099-01-01T00:00:00Z",
      coveredThrough: "2099-01-01T00:00:00Z",
      heartbeatAt: "2099-01-01T00:00:00Z",
    }, decision)).toBe(false)
    expect(observerAllowsRestoration(coverage)).toBe(false)
  })

  test("native complete cleanup не допускает held input", () => {
    const observer = {
      state: "ready",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      coverageStartCursor: "observer:start:1",
      cursor: "observer:current:1",
      nextSequence: 10,
      startedAt: "2026-09-15T09:59:00.000Z",
      coveredFrom: "2026-09-15T09:59:00.000Z",
      coveredThrough: "2026-09-15T09:59:59.900Z",
      heartbeatAt: "2026-09-15T10:00:00.000Z",
      coveredKinds: ["input", "focus"],
      droppedEvents: 0,
      gapDetected: false,
    }
    expect(nativeOperationStatusSchema.safeParse({
      requestId: "status-request:finished",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      highWaterFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 2 },
      acceptedFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 2 },
      operationId: "operation:1",
      execution: "finished",
      dispatch: "finished",
      cleanup: "complete",
      targetVerified: "verified",
      cancellationRequested: false,
      userInterference: "none-observed",
      restorationAllowed: true,
      quarantined: false,
      heldCount: 5,
      dispatchAttempts: 1,
      ledgerRevision: 4,
      observer,
    }).success).toBe(false)
  })

  test("dispatch и restore не принимают stale accepted fence ниже high-water", () => {
    const observer = {
      state: "ready",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      coverageStartCursor: "observer:start:1",
      cursor: "observer:current:1",
      nextSequence: 10,
      startedAt: "2026-09-15T09:59:00.000Z",
      coveredFrom: "2026-09-15T09:59:00.000Z",
      coveredThrough: "2026-09-15T09:59:59.900Z",
      heartbeatAt: "2026-09-15T10:00:00.000Z",
      coveredKinds: ["input", "focus"],
      droppedEvents: 0,
      gapDetected: false,
    }
    const stale = {
      requestId: "status-request:stale-fence",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      highWaterFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 2 },
      acceptedFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      operationId: "operation:old",
      dispatch: "attempted",
      cleanup: "unknown",
      targetVerified: "verified",
      cancellationRequested: false,
      userInterference: "none-observed",
      restorationAllowed: false,
      quarantined: false,
      heldCount: 0,
      dispatchAttempts: 1,
      ledgerRevision: 1,
      observer,
    }
    expect(nativeOperationStatusSchema.safeParse({ ...stale, execution: "dispatching" }).success).toBe(false)
    expect(nativeOperationStatusSchema.safeParse({
      ...stale,
      execution: "failed",
      cleanup: "complete",
      restorationAllowed: true,
    }).success).toBe(false)
    expect(nativeOperationStatusSchema.safeParse({
      ...stale,
      execution: "cancelling",
      cancellationRequested: true,
    }).success).toBe(true)
  })

  test("cancel ACK коррелируется с request, operation, fence и generation", () => {
    const request = nativeCancelRequestSchema.parse({
      requestId: "cancel-request:1",
      operationId: "operation:1",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      deadlineAt,
      fence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      reason: "client cancellation",
    })
    const ack = nativeCancelAckSchema.parse({
      requestId: request.requestId,
      operationId: request.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      fence: request.fence,
      acknowledged: true,
      stopped: true,
      cleanup: "complete",
      ledgerRevision: 3,
      lastCheckpoint: "cancelled-before-event",
      quarantined: false,
    })
    expect(nativeCancelAckMatches(request, ack)).toBe(true)
    expect(nativeCancelAckMatches(request, { ...ack, requestId: "cancel-request:late" })).toBe(false)
  })

  test("cleanup-only lifecycle использует fresh bounded deadline и retained terminal receipt", () => {
    const control = nativeCleanupControlSchema.parse({
      kind: "cleanup-only",
      purpose: "release",
      requestId: "cleanup-rpc:1",
      cleanupRequestId: "cleanup-idempotency:1",
      operationId: "operation:expired",
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      acceptedFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
      currentHighWaterFence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 2 },
      deadlineAt: "2026-09-15T10:05:00.000Z",
      expectedStatusRevision: 7,
      expectedDrainedEvidenceRef: "drained-evidence:1",
    })
    const requestSchema = createNativeCleanupRequestSchema(z.strictObject({ captureTaskRef: z.string().min(1).max(127) }))
    expect(requestSchema.parse({ control, payload: { captureTaskRef: "capture-task:1" } })).not.toHaveProperty("operation.deadlineAt")
    expect(requestSchema.safeParse({
      control,
      payload: { captureTaskRef: "capture-task:1", recoveryAuthorized: true },
    }).success).toBe(false)
    const ack = nativeCleanupAckSchema.parse({
      kind: "cleanup-ack",
      requestId: control.requestId,
      cleanupRequestId: control.cleanupRequestId,
      operationId: control.operationId,
      runtimeEpoch,
      loginSessionId,
      nativeGeneration,
      acceptedFence: control.acceptedFence,
      currentHighWaterFence: control.currentHighWaterFence,
      statusRevision: 8,
      drainedEvidenceRef: control.expectedDrainedEvidenceRef,
      terminalReceiptRef: "native-terminal-receipt:1",
      cleanup: "complete",
      drained: true,
      quarantined: false,
    })
    expect(nativeCleanupAckMatches(control, ack)).toBe(true)
    expect(nativeCleanupAckMatches(control, { ...ack, cleanupRequestId: "cleanup-idempotency:late" })).toBe(false)
    expect(nativeCleanupAckSchema.safeParse({ ...ack, terminalReceiptRef: undefined, drained: false }).success).toBe(false)
  })
})

describe("C1 operation outcome matrix", () => {
  test("registered/dispatching удерживают exact pending leases, terminal states их запрещают", async () => {
    const context = browserContext()
    const handle = runtimeResourceHandleSchema.parse(resourceHandle("cdp-target", browserTargetRef.resourceRef, context.operationId))
    const pendingOutcome = {
      dispatch: "none",
      targetVerified: "unknown",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: { scope: "owned", state: "pending", resources: [{ handle, outcome: "held" }] },
      restoration: "not-applicable",
      dispatchAttempts: 0,
    }
    const recordInput = {
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      intent: "mutation",
      context,
      outcome: pendingOutcome,
      resources: [handle],
      payloadReceipt: { keyGeneration: "hmac:1", hmacSha256: "e".repeat(64) },
      registeredAt: "2026-09-15T09:59:59.000Z",
      updatedAt: now,
    }
    const registered = operationRecordSchema.parse({ ...recordInput, state: "registered" })
    expect(operationRecordSchema.safeParse({ ...recordInput, state: "dispatching" }).success).toBe(true)
    for (const state of ["completed", "failed", "cancelled", "interrupted-unknown"] as const) {
      expect(operationRecordSchema.safeParse({ ...recordInput, state }).success).toBe(false)
    }
    expect(operationRecordSchema.safeParse({
      ...recordInput,
      state: "registered",
      outcome: {
        ...pendingOutcome,
        cleanup: { scope: "owned", state: "pending", resources: [] },
      },
    }).success).toBe(false)
    const foreign = { ...handle, leaseId: "lease:foreign" }
    expect(operationRecordSchema.safeParse({
      ...recordInput,
      state: "registered",
      outcome: {
        ...pendingOutcome,
        cleanup: { scope: "owned", state: "pending", resources: [{ handle: foreign, outcome: "held" }] },
      },
    }).success).toBe(false)
    const receipt = cleanupAuthorityReceiptSchema.parse({
      receiptId: "cleanup-receipt:pending",
      authorityRef: "cleanup-authority:1",
      operationId: context.operationId,
      runtimeEpoch,
      loginSessionId,
      issuedAt: now,
      state: "complete",
      leases: [{ leaseId: handle.leaseId, leaseGeneration: handle.leaseGeneration }],
    })
    expect(await operationCanReleaseMutationLease({ async verify() { throw new Error("не должен вызываться") } }, registered, receipt)).toBe(false)
  })

  test("read-only completion допускает dispatch none", () => {
    const context = browserContext()
    const record = operationRecordSchema.parse({
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      intent: "read",
      context,
      state: "completed",
      outcome: outcome(),
      resources: [],
      payloadReceipt: { keyGeneration: "hmac:1", hmacSha256: "c".repeat(64) },
      registeredAt: "2026-09-15T09:59:59.000Z",
      updatedAt: now,
    })
    expect(record.outcome.dispatch).toBe("none")
  })

  test("malformed verified mutation отклоняется, failed cleanup unknown сохраняется и не освобождает lease", async () => {
    const context = browserContext()
    const base = {
      clientSessionId: session.clientSessionId,
      principalId: session.principalId,
      intent: "mutation",
      context,
      resources: [],
      payloadReceipt: { keyGeneration: "hmac:1", hmacSha256: "d".repeat(64) },
      registeredAt: "2026-09-15T09:59:59.000Z",
      updatedAt: now,
    }
    expect(operationRecordSchema.safeParse({
      ...base,
      state: "completed",
      outcome: {
        ...outcome(),
        effect: { state: "verified", proofRefs: ["proof:effect"] },
      },
    }).success).toBe(false)
    const handle = runtimeResourceHandleSchema.parse(resourceHandle("cdp-target", browserTargetRef.resourceRef, context.operationId))
    expect(operationRecordSchema.safeParse({
      ...base,
      state: "completed",
      resources: [handle],
      outcome: outcome(noCleanup),
    }).success).toBe(false)
    const failed = operationRecordSchema.parse({
      ...base,
      state: "failed",
      resources: [handle],
      outcome: outcome({
        scope: "owned",
        state: "unknown",
        reason: "native channel lost",
        resources: [{ handle, outcome: "quarantined" }],
      }),
      error: {
        code: "operation-outcome-unknown",
        message: "delivery неизвестна",
        stage: "native-response",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
    })
    expect(failed.outcome.cleanup.state).toBe("unknown")
    const receipt = cleanupAuthorityReceiptSchema.parse({
      receiptId: "cleanup-receipt:1",
      authorityRef: "cleanup-authority:1",
      operationId: context.operationId,
      runtimeEpoch,
      loginSessionId,
      issuedAt: now,
      state: "complete",
      leases: [{ leaseId: handle.leaseId, leaseGeneration: handle.leaseGeneration }],
    })
    expect(await operationCanReleaseMutationLease({
      async verify() {
        throw new Error("unknown cleanup не должен проверяться как complete")
      },
    }, failed, receipt)).toBe(false)
    const completed = operationRecordSchema.parse({
      ...base,
      state: "completed",
      resources: [handle],
      outcome: {
        dispatch: "finished",
        targetVerified: "verified",
        userInterference: "none-observed",
        observation: "available",
        effect: { state: "unverified", proofRefs: [] },
        cleanup: {
          scope: "owned",
          state: "complete",
          resources: [{ handle, outcome: "released" }],
        },
        restoration: "not-applicable",
        dispatchAttempts: 1,
      },
    })
    let authorityChecked = false
    expect(await operationCanReleaseMutationLease({
      async verify(received, handles) {
        authorityChecked = received.receiptId === receipt.receiptId && handles[0]?.leaseId === handle.leaseId
      },
    }, completed, receipt)).toBe(true)
    expect(authorityChecked).toBe(true)
  })
})

function targetLossStatus() {
  return {
    requestId: "target-loss-status", runtimeEpoch, loginSessionId, nativeGeneration,
    operationId: nativeContext().operationId, acceptedFence: nativeContext().fence, highWaterFence: nativeContext().fence,
    execution: "failed", dispatch: "partial", cleanup: "complete", targetVerified: "failed",
    cancellationRequested: false, userInterference: "unknown", restorationAllowed: false,
    quarantined: false, heldCount: 0, dispatchAttempts: 2, ledgerRevision: 4, lastCheckpoint: "cleanup-up",
    observer: { runtimeEpoch, loginSessionId, nativeGeneration, state: "unavailable",
      coverageStartCursor: "cursor:0", cursor: "cursor:0", nextSequence: 1,
      startedAt: now, coveredFrom: now, coveredThrough: now, heartbeatAt: now,
      coveredKinds: [], droppedEvents: 0, gapDetected: false, reason: "fixture" },
  }
}

test("native status сохраняет target loss после down и достоверный cleanup", () => {
  const failed = targetLossStatus()
  expect(nativeOperationStatusSchema.parse(failed)).toMatchObject({
    execution: "failed", dispatch: "partial", targetVerified: "failed", cleanup: "complete", heldCount: 0,
  })
  expect(nativeOperationStatusSchema.safeParse({ ...failed, execution: "cancelling",
    dispatch: "attempted", cleanup: "incomplete", heldCount: 1 }).success).toBe(true)
  expect(nativeOperationStatusSchema.safeParse({ ...failed, execution: "cancelling",
    cleanup: "incomplete", heldCount: 1 }).success).toBe(true)
  expect(nativeOperationStatusSchema.safeParse({ ...failed, execution: "quarantined",
    dispatch: "unknown", cleanup: "unknown", quarantined: true, heldCount: 1 }).success).toBe(true)
})

test("target loss не разрешает продолжение ввода, success, restore или выдуманный dispatch", () => {
  const failed = targetLossStatus()
  for (const invalid of [
    { execution: "dispatching" }, { execution: "finished" }, { execution: "cancelled" },
    { targetVerified: "unknown" }, { restorationAllowed: true }, { dispatchAttempts: 0 },
    { dispatch: "finished" }, { dispatch: "attempted" },
    { cleanup: "complete", heldCount: 1 },
    { execution: "quarantined", dispatch: "unknown", quarantined: false },
    { nativeGeneration: "native:foreign" },
  ]) {
    expect(nativeOperationStatusSchema.safeParse({ ...failed, ...invalid }).success).toBe(false)
  }
})
