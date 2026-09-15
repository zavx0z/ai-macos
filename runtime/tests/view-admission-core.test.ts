import { expect, test } from "bun:test"
import { runtimeOperationIntentSchema, type NativeAdapter, type NativeExecutionContext } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"

function fixture() {
  const generation = { runtimeEpoch: "runtime:view-core", loginSessionId: "login:view-core" }
  const nativeGeneration = "native:view-core"
  const core = new RuntimeCore({ generation, nativeGeneration, native: {} as NativeAdapter, runtimeBuildId: "build:view-core" })
  const session = core.openClient("principal:view-core").session
  const target = { kind: "window" as const, ref: { ...generation, nativeGeneration, applicationRef: "app:view-core", windowRef: "window:view-core" } }
  core.targets.register(target, "inventory:view-core", 1, "resolution:view-core", "proof:view-core", 0)
  const intent = runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:view-core",
    precondition: { target, inventoryId: "inventory:view-core", inventoryRevision: 1 },
    deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }] })
  return { core, session, intent }
}

test("view authorizer допускает только точный active Core context и не доверяет caller opId", async () => {
  const { core, session, intent } = fixture()
  let calls = 0
  let saved: NativeExecutionContext | undefined
  const authorize = core.bindNativeViewAdmission(async context => {
    calls++
    expect(context.lineageId).toBe(core.clients.lineage(session))
    expect(context.operation.method).toBe("input.execute")
    await context.control.checkpoint()
    return { operationId: context.wire.operationId }
  })
  try {
    const execution = await core.runOperation(session, intent, {}, async context => {
      if (context.wire.kind !== "native") throw new Error("Native context expected")
      saved = context.wire
      await expect(authorize({ ...saved, operationId: "forged:operation" }, { method: "input.execute" })).rejects.toThrow("exact active")
      await expect(authorize({ ...saved, clientRequestId: "forged:request" }, { method: "input.execute" })).rejects.toThrow("exact active")
      expect(await authorize(saved, { method: "input.execute", actionKind: "text" })).toEqual({ operationId: saved.operationId })
      throw new Error("Fixture stops before any Native send")
    })
    expect(calls).toBe(1)
    await expect(authorize(saved!, { method: "input.execute" })).rejects.toThrow("exact active")
    expect(() => core.bindNativeViewAdmission(async () => ({}))).toThrow("immutable")
    expect(await core.getOperation(session, execution.operation.context.operationId)).toBeDefined()
  } finally { await core.closeClientLifecycle() }
})

test("отмена во время guard check отзывает late proof и сохраняет status операции", async () => {
  const { core, session, intent } = fixture()
  const caller = new AbortController()
  const authorize = core.bindNativeViewAdmission(async () => {
    caller.abort(new Error("cancel view check"))
    await Promise.resolve()
    return { accepted: true }
  })
  try {
    const execution = await core.runOperation(session, intent, {}, async context => {
      if (context.wire.kind !== "native") throw new Error("Native context expected")
      await expect(authorize(context.wire, { method: "ax.press" })).rejects.toThrow("cancel view check")
      throw new Error("No Native send after cancelled proof")
    }, caller.signal)
    expect(execution.operation.state).not.toBe("completed")
    expect(execution.operation.outcome.effect.state).toBe("unverified")
    expect((await core.getOperationByRequest(session, intent.clientRequestId))?.context.operationId).toBe(execution.operation.context.operationId)
  } finally { await core.closeClientLifecycle() }
})

test("durable poison во время view provider не выпускает late admission proof", async () => {
  const generation = { runtimeEpoch: "runtime:view-poison", loginSessionId: "login:view-poison" }
  let writes = 0
  const core = new RuntimeCore({ generation, nativeGeneration: "native:view-poison", native: {} as NativeAdapter,
    runtimeBuildId: "build:view-poison", durableTimeoutMs: 5,
    clientPersistence: { sessions: [], async persist() { if (++writes > 1) await new Promise(() => {}) } } })
  const session = (await core.openClientDurable("principal:view-poison")).session
  const target = { kind: "window" as const, ref: { ...generation, nativeGeneration: "native:view-poison", applicationRef: "app:poison", windowRef: "window:poison" } }
  core.targets.register(target, "inventory:poison", 1, "resolution:poison", "proof:poison", 0)
  const authorize = core.bindNativeViewAdmission(async () => {
    await expect(core.openClientDurable("principal:other")).rejects.toThrow("deadline")
    return { shouldNeverEscape: true }
  })
  let escaped = false
  try {
    const result = await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:poison",
      precondition: { target, inventoryId: "inventory:poison", inventoryRevision: 1 },
      deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
    }), {}, async context => {
      if (context.wire.kind !== "native") throw new Error("Native expected")
      await authorize(context.wire, { method: "ax.press" })
      escaped = true
      throw new Error("Must not reach Native send")
    })
    expect(escaped).toBe(false)
    expect(core.admissionSealed).toBe(true)
    expect(result.operation.state).not.toBe("completed")
  } finally { await core.closeClientLifecycle() }
})
