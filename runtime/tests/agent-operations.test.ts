import { bindDeadline, signalDeadline } from "../src/deadline.ts"
import { describe, expect, test } from "bun:test"
import {
  operationRecordSchema,
  runtimeOperationIntentSchema,
  runtimeClientSessionSchema,
  type OperationRecord,
  type NativeAdapter,
  type RuntimeResourceHandle,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import {
  AGENT_OPERATION_RETENTION_MS,
  AgentOperations,
  type AgentActionTargetBinding,
  type AgentOperationTargetRegistry,
  type AgentOperationTargetScope,
} from "../src/agent-operations.ts"
import { AgentTargetRegistry, type AgentTarget } from "../src/agent-targets.ts"
import { RuntimeCore } from "../src/core.ts"

const generation = {
  runtimeEpoch: "runtime:agent",
  loginSessionId: "login:agent",
}
const target: AgentTarget = {
  kind: "window",
  ref: {
    ...generation,
    nativeGeneration: "native:agent",
    applicationRef: "application:agent",
    windowRef: "window:agent",
  },
}

function session(
  id: string,
  principal: string,
  expiresAt = "2026-09-16T10:00:00.000Z",
): RuntimeClientSession {
  return runtimeClientSessionSchema.parse({
    clientSessionId: id,
    principalId: principal,
    ...generation,
    authenticationGeneration: `auth:${id}`,
    authenticatedAt: "2026-09-15T10:00:00.000Z",
    expiresAt,
  })
}

function operation(
  client: RuntimeClientSession,
  clientRequestId: string,
  operationId: string,
  state: "dispatching" | "completed" | "cancelled" | "interrupted-unknown",
  cleanup: "complete" | "unknown" = "complete",
): OperationRecord {
  const unknown = cleanup === "unknown"
  const handle: RuntimeResourceHandle = {
    kind: "desktop-input",
    resourceRef: "desktop",
    leaseId: `lease:${operationId}`,
    leaseGeneration: "lease-generation:agent",
    operationId,
    clientSessionId: client.clientSessionId,
    principalId: client.principalId,
    ...generation,
    expiresAt: "2026-09-16T09:00:00.000Z",
    state: "quarantined",
  }
  return operationRecordSchema.parse({
    clientSessionId: client.clientSessionId,
    principalId: client.principalId,
    intent: "mutation",
    context: {
      kind: "native",
      operationId,
      clientRequestId,
      clientSessionId: client.clientSessionId,
      principalId: client.principalId,
      ...generation,
      nativeGeneration: "native:agent",
      inventoryId: "inventory:agent",
      inventoryRevision: 1,
      deadlineAt: "2026-09-16T09:00:00.000Z",
      target,
      fence: {
        ...generation,
        nativeGeneration: "native:agent",
        counter: 1,
      },
    },
    state,
    outcome: {
      dispatch: state === "dispatching" ? "attempted" : unknown ? "unknown" : "finished",
      targetVerified: "verified",
      userInterference: "unknown",
      observation: "unavailable",
      effect: { state: "unverified", proofRefs: [] },
      cleanup: unknown ? {
        scope: "owned",
        state: "unknown",
        resources: [{ handle, outcome: "quarantined" }],
        reason: "native cleanup unknown",
      } : { scope: "none", state: "complete", resources: [] },
      restoration: unknown ? "unknown" : "not-applicable",
      dispatchAttempts: 1,
    },
    resources: unknown ? [handle] : [],
    payloadReceipt: {
      keyGeneration: "hmac:agent",
      hmacSha256: "a".repeat(64),
    },
    registeredAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:01.000Z",
    ...(state === "interrupted-unknown" ? {
      error: {
        code: "operation-outcome-unknown",
        message: "delivery unknown",
        stage: "fixture",
        retryable: false,
        replayAllowed: false,
        recoveryAction: "get-operation",
      },
    } : {}),
  })
}

class FakeRuntime {
  readonly records = new Map<string, OperationRecord>()
  readonly lineages = new Map<string, string>()
  readonly clients = {
    assertActive: async (client: RuntimeClientSession, now: Date) => {
      if (!this.lineages.has(client.clientSessionId)
        || Date.parse(client.expiresAt) <= now.getTime()) {
        throw new Error("inactive session")
      }
    },
    lineage: (client: RuntimeClientSession) => {
      const lineage = this.lineages.get(client.clientSessionId)
      if (lineage === undefined) throw new Error("foreign session")
      return lineage
    },
  }

  async getOperationByRequest(
    _client: RuntimeClientSession,
    clientRequestId: string,
  ) {
    return this.records.get(clientRequestId)
  }

  async cancelOperation(
    client: RuntimeClientSession,
    operationId: string,
    _reason: string,
  ) {
    const entry = [...this.records.entries()].find(([, value]) => {
      return value.context.operationId === operationId
        && value.clientSessionId === client.clientSessionId
    })
    if (entry === undefined) throw new Error("foreign operation")
    const cancelled = operation(
      client,
      entry[0],
      operationId,
      "cancelled",
    )
    this.records.set(entry[0], cancelled)
    return cancelled
  }
}

class FakeTargetScope implements AgentOperationTargetScope {
  closed = false
  actionExpired = false
  readonly retained = new Set<string>()

  constructor(
    readonly targetId: string,
    readonly bindingTarget: AgentTarget,
  ) {}

  resolveAction(targetId: string): AgentActionTargetBinding {
    if (targetId !== this.targetId || this.closed || this.actionExpired) {
      throw new Error("target closed, expired or foreign")
    }
    return {
      targetId,
      target: this.bindingTarget,
      inventoryId: "inventory:agent",
      inventoryRevision: 1,
      actionExpiresAt: "2026-09-16T09:00:00.000Z",
    }
  }

  resolveControl(targetId: string) {
    if (targetId !== this.targetId) throw new Error("foreign target")
    return {
      ...this.resolveBinding(targetId),
      state: this.closed ? "closed" as const : "active" as const,
      ...(this.closed ? { reason: "window closed" } : {}),
      controlExpiresAt: "2026-09-16T10:00:00.000Z",
    }
  }

  retainControl(_targetId: string, ownerKey: string) {
    this.retained.add(ownerKey)
  }

  releaseControl(_targetId: string, ownerKey: string) {
    this.retained.delete(ownerKey)
  }

  private resolveBinding(targetId: string) {
    return {
      targetId,
      target: this.bindingTarget,
      inventoryId: "inventory:agent",
      inventoryRevision: 1,
      actionExpiresAt: "2026-09-16T09:00:00.000Z",
    }
  }
}

class FakeTargets implements AgentOperationTargetRegistry {
  readonly scopes = new Map<string, FakeTargetScope>()
  forLineage(lineage: string) {
    const scope = this.scopes.get(lineage)
    if (scope === undefined) throw new Error("foreign lineage")
    return scope
  }
}

function fixture() {
  const runtime = new FakeRuntime()
  const targets = new FakeTargets()
  const first = session("client:first", "principal:first")
  const foreign = session("client:foreign", "principal:foreign")
  runtime.lineages.set(first.clientSessionId, "lineage:first")
  runtime.lineages.set(foreign.clientSessionId, "lineage:foreign")
  const firstScope = new FakeTargetScope("target:window", target)
  const foreignScope = new FakeTargetScope("target:foreign", target)
  targets.scopes.set("lineage:first", firstScope)
  targets.scopes.set("lineage:foreign", foreignScope)
  let counter = 0
  const operations = new AgentOperations({
    runtime,
    targets,
    ids: { next(prefix) { counter += 1; return `${prefix}:${counter}` } },
    clock: { now: () => new Date("2026-09-15T10:00:00.000Z") },
  })
  return { runtime, targets, first, foreign, firstScope, operations }
}

describe("agent operation control", () => {
  test("cancel_target видит pending и queued до возврата исходных calls", async () => {
    const { runtime, first, firstScope, operations } = fixture()
    let firstStarted!: () => void
    const started = new Promise<void>(resolve => { firstStarted = resolve })
    let executions = 0
    const run = () => operations.runTrackedMutation(
      first,
      "target:window",
      "type-text",
      async context => {
        executions += 1
        runtime.records.set(context.clientRequestId, operation(
          first,
          context.clientRequestId,
          `operation:${executions}`,
          "dispatching",
        ))
        firstStarted()
        await new Promise<never>((_, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
        })
      },
    )
    const firstRun = run()
    await started
    const queuedRun = run()
    const cancelled = await operations.cancelTarget(
      first,
      "target:window",
      "user requested",
    )
    await Promise.allSettled([firstRun, queuedRun])
    const final = await operations.getTargetStatus(first, "target:window")
    expect(cancelled.recent.some(item => item.outcome?.state === "cancelled")).toBe(true)
    expect(final.recent).toHaveLength(2)
    expect(final.recent.some(item => item.phase === "cancelled-before-admission")).toBe(true)
    expect(executions).toBe(1)
    expect(firstScope.retained.size).toBe(0)
  })

  test("caller abort немедленно снимает queued action без нарушения tail", async () => {
    const { runtime, first, operations } = fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    let executions = 0
    const firstRun = operations.runTrackedMutation(first, "target:window", "type-text", async context => {
      executions += 1
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:queue-head",
        "dispatching",
      ))
      started()
      await waiting
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:queue-head",
        "completed",
      ))
    })
    await firstStarted
    const controller = new AbortController()
    const queued = operations.runTrackedMutation(
      first,
      "target:window",
      "type-text",
      async () => { executions += 1 },
      controller.signal,
    )
    controller.abort(new Error("queued caller abort"))
    await expect(Promise.race([
      queued,
      new Promise((_, reject) => setTimeout(() => reject(new Error("queued abort timeout")), 50)),
    ])).rejects.toThrow("queued caller abort")
    expect(executions).toBe(1)
    const thirdRun = operations.runTrackedMutation(first, "target:window", "type-text", async context => {
      executions += 1
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:queue-third",
        "completed",
      ))
    })
    await Promise.resolve()
    expect(executions).toBe(1)
    release()
    await Promise.all([firstRun, thirdRun])
    expect(executions).toBe(2)
  })

  test("foreign lineage не видит и не отменяет чужой target", async () => {
    const { runtime, first, foreign, operations } = fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const running = operations.runTrackedMutation(first, "target:window", "press-key", async context => {
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:foreign-guard",
        "dispatching",
      ))
      await waiting
      return "done"
    })
    await Promise.resolve()
    await expect(operations.cancelTarget(foreign, "target:window", "foreign"))
      .rejects.toThrow()
    expect((await operations.getTargetStatus(first, "target:window")).active).toHaveLength(1)
    release()
    runtime.records.set(
      [...runtime.records.keys()][0]!,
      operation(first, [...runtime.records.keys()][0]!, "operation:foreign-guard", "completed"),
    )
    await running
  })

  test("lost response сохраняет authoritative Core outcome без replay", async () => {
    const { runtime, first, operations } = fixture()
    let calls = 0
    await expect(operations.runTrackedMutation(first, "target:window", "show-window", async context => {
      calls += 1
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:lost-response",
        "completed",
      ))
      throw new Error("response channel lost")
    })).rejects.toThrow("response channel lost")
    const status = await operations.getTargetStatus(first, "target:window")
    expect(status.recent[0]?.outcome?.state).toBe("completed")
    expect(status.recent[0]?.operationId).toBe("operation:lost-response")
    expect(status.recent[0]).not.toHaveProperty("authoritative")
    expect(status).not.toHaveProperty("target")
    expect(JSON.stringify(status)).not.toContain("response channel lost")
    expect(calls).toBe(1)
  })

  test("expired client session не читает target control state", async () => {
    const { runtime, operations } = fixture()
    const expired = runtimeClientSessionSchema.parse({
      ...session("client:expired", "principal:first"),
      authenticatedAt: "2026-09-14T08:00:00.000Z",
      expiresAt: "2026-09-15T09:00:00.000Z",
    })
    runtime.lineages.set(expired.clientSessionId, "lineage:first")
    await expect(operations.getTargetStatus(expired, "target:window"))
      .rejects.toThrow("inactive session")
  })

  test("closed target сохраняет status/cancel, но запрещает новую action", async () => {
    const { runtime, first, firstScope, operations } = fixture()
    await operations.runTrackedMutation(first, "target:window", "show-window", async context => {
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:closed",
        "completed",
      ))
      return "ok"
    })
    firstScope.closed = true
    await expect(operations.runTrackedMutation(first, "target:window", "show-window", async () => "no"))
      .rejects.toThrow("closed")
    expect((await operations.getTargetStatus(first, "target:window")).targetState).toBe("closed")
    expect((await operations.cancelTarget(first, "target:window", "closed cleanup")).recent)
      .toHaveLength(1)
  })

  test("action expiry сохраняет status/cancel, но запрещает новую action", async () => {
    const { runtime, first, firstScope, operations } = fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    let executions = 0
    const firstRun = operations.runTrackedMutation(first, "target:window", "show-window", async context => {
      executions += 1
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:expired",
        "dispatching",
      ))
      started()
      await waiting
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:expired",
        "completed",
      ))
      return "ok"
    })
    await firstStarted
    const queuedRun = operations.runTrackedMutation(
      first,
      "target:window",
      "show-window",
      async () => {
        executions += 1
        return "must not run"
      },
    )
    firstScope.actionExpired = true
    release()
    await firstRun
    await expect(queuedRun).rejects.toThrow("expired")
    expect(executions).toBe(1)
    expect((await operations.getTargetStatus(first, "target:window")).recent[0]?.outcome?.state)
      .toBe("completed")
    expect((await operations.cancelTarget(first, "target:window", "expired cleanup")).recent)
      .toHaveLength(1)
  })

  test("unknown cleanup не pruning после terminal retention", async () => {
    const runtime = new FakeRuntime()
    const targets = new FakeTargets()
    const first = session("client:unknown", "principal:unknown", "2026-09-20T10:00:00.000Z")
    runtime.lineages.set(first.clientSessionId, "lineage:unknown")
    targets.scopes.set("lineage:unknown", new FakeTargetScope("target:window", target))
    let now = Date.parse("2026-09-15T10:00:00.000Z")
    let counter = 0
    const operations = new AgentOperations({
      runtime,
      targets,
      ids: { next(prefix) { counter += 1; return `${prefix}:${counter}` } },
      clock: { now: () => new Date(now) },
    })
    await operations.runTrackedMutation(first, "target:window", "type-text", async context => {
      runtime.records.set(context.clientRequestId, operation(
        first,
        context.clientRequestId,
        "operation:unknown",
        "interrupted-unknown",
        "unknown",
      ))
      return "unknown"
    })
    now += AGENT_OPERATION_RETENTION_MS * 2
    const status = await operations.getTargetStatus(first, "target:window")
    expect(status.recent[0]?.outcome?.state).toBe("interrupted-unknown")
  })

  test("TargetRegistry удерживает unknown cleanup до подтверждённого release", async () => {
    const runtime = new FakeRuntime()
    const first = session("client:registry", "principal:registry")
    runtime.lineages.set(first.clientSessionId, "lineage:registry")
    let now = Date.parse("2026-09-15T10:00:00.000Z")
    let registryCounter = 0
    const registry = new AgentTargetRegistry({
      generation,
      clock: { now: () => new Date(now) },
      ids: { next(prefix) { registryCounter += 1; return `${prefix}:${registryCounter}` } },
      actionTtlMs: 50,
      controlRetentionMs: 100,
    })
    const scope = registry.forLineage("lineage:registry")
    const handle = scope.registerTarget(target, {
      inventoryId: "inventory:agent",
      inventoryRevision: 1,
    })
    let operationCounter = 0
    const operations = new AgentOperations({
      runtime,
      targets: registry,
      clock: { now: () => new Date(now) },
      ids: { next(prefix) { operationCounter += 1; return `${prefix}:${operationCounter}` } },
    })
    let clientRequestId = ""
    await operations.runTrackedMutation(first, handle.targetId, "type-text", async context => {
      clientRequestId = context.clientRequestId
      runtime.records.set(clientRequestId, operation(
        first,
        clientRequestId,
        "operation:registry-unknown",
        "interrupted-unknown",
        "unknown",
      ))
    })
    now += 101
    registry.prune()
    expect(scope.resolveControl(handle.targetId).targetId).toBe(handle.targetId)
    const unknown = runtime.records.get(clientRequestId)
    if (unknown === undefined) throw new Error("Unknown fixture record отсутствует")
    runtime.records.set(clientRequestId, operationRecordSchema.parse({
      ...unknown,
      outcome: {
        ...unknown.outcome,
        cleanup: {
          scope: "owned",
          state: "complete",
          resources: unknown.resources.map(resource => ({ handle: resource, outcome: "released" as const })),
        },
      },
      updatedAt: "2026-09-15T10:00:01.000Z",
    }))
    await operations.getTargetStatus(first, handle.targetId)
    now += 101
    registry.prune()
    expect(() => scope.resolveControl(handle.targetId)).toThrow()
  })

  test("обёртка tracked action сохраняет общий deadline и caller cancellation", async () => {
    const { runtime, first, operations, firstScope } = fixture()
    const caller = new AbortController()
    const deadlineAt = Date.parse("2026-09-15T10:00:30.000Z")
    bindDeadline(caller.signal, deadlineAt)
    const cancelled = new Error("caller остановил action")
    await expect(operations.runTrackedMutation(first, "target:window", "press-key", async context => {
      expect(context.signal).not.toBe(caller.signal)
      expect(signalDeadline(context.signal)).toBe(deadlineAt)
      caller.abort(cancelled)
      expect(context.signal.aborted).toBe(true)
      runtime.records.set(context.clientRequestId, operation(first, context.clientRequestId,
        "operation:deadline", "cancelled"))
      context.signal.throwIfAborted()
    }, caller.signal)).rejects.toThrow(cancelled.message)
    expect(firstScope.retained.size).toBe(0)
  })

  test("real RuntimeCore остаётся authority при cancel pending handler", async () => {
    const clock = { now: () => new Date("2026-09-15T10:00:00.000Z") }
    const runtime = new RuntimeCore({
      clock,
      generation,
      runtimeBuildId: "runtime-build:agent",
      nativeGeneration: "native:agent",
      native: {} as NativeAdapter,
      secret: new Uint8Array(32).fill(7),
      cancelGraceMs: 5,
    })
    runtime.targets.register(
      target,
      "inventory:agent",
      1,
      "resolution:agent",
      "proof:agent",
      1,
      { kind: "window", cgWindowId: 10, ownerPid: 20, displays: [] },
    )
    const client = runtime.openClient("principal:real-core")
    const lineage = runtime.clients.lineage(client.session)
    const targets = new FakeTargets()
    targets.scopes.set(lineage, new FakeTargetScope("target:window", target))
    let counter = 0
    const operations = new AgentOperations({
      clock,
      runtime,
      targets,
      ids: { next(prefix) { counter += 1; return `${prefix}:${counter}` } },
    })
    let adapterStarted!: () => void
    const started = new Promise<void>(resolve => { adapterStarted = resolve })
    const running = operations.runTrackedMutation(
      client.session,
      "target:window",
      "type-text",
      async context => runtime.runOperation(
        client.session,
        runtimeOperationIntentSchema.parse({
          intent: "mutation",
          clientRequestId: context.clientRequestId,
          precondition: {
            target: context.binding.target,
            inventoryId: context.binding.inventoryId,
            inventoryRevision: context.binding.inventoryRevision,
          },
          deadlineAt: new Date(clock.now().getTime() + 30_000).toISOString(),
          requestedResources: [],
        }),
        { text: "fixture" },
        async (): Promise<never> => {
          adapterStarted()
          return await new Promise<never>(() => {})
        },
        context.signal,
      ),
    )
    await started
    const cancelled = await operations.cancelTarget(
      client.session,
      "target:window",
      "fixture cancellation",
    )
    await running
    expect(cancelled.recent[0]?.outcome).toMatchObject({
      state: "interrupted-unknown",
      cleanup: "complete",
    })
  })
})
