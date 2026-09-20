import { expect, test } from "bun:test"
import { runtimeOperationIntentSchema, type NativeAdapter, type NativeViewAdmission } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { AgentViewBindings } from "../src/agent-view-bindings.ts"
import type { AgentViewScope, AgentViewTicket } from "../src/agent-view-guard.ts"

function fixture() {
  const generation = { runtimeEpoch: "runtime:view-bind", loginSessionId: "login:view-bind" }
  const nativeGeneration = "native:view-bind"
  const core = new RuntimeCore({ generation, nativeGeneration, native: {} as NativeAdapter, runtimeBuildId: "build:view-bind" })
  const session = core.openClient("principal:view-bind").session
  const target = { kind: "window" as const, ref: { ...generation, nativeGeneration, applicationRef: "app:view-bind", windowRef: "window:view-bind" } }
  core.targets.register(target, "inventory:view-bind", 1, "resolution:view-bind", "proof:view-bind", 0)
  let admitted = 0
  let retired = 0
  let ticket: AgentViewTicket | undefined
  const invalidated = new WeakSet<AgentViewTicket>()
  const forgotten = new WeakSet<AgentViewTicket>()
  const scope: AgentViewScope = {
    async beginObservation(targetId) { return { targetId, startedAt: new Date().toISOString() } },
    async commitObservation(draft) {
      ticket = { targetId: draft.targetId, observedAt: draft.startedAt, expiresAt: new Date(Date.now() + 5000).toISOString() }
      return ticket
    },
    cancelObservation() {},
    async admit(value, operationId) {
      if (value !== ticket || invalidated.has(value)) throw new Error("Forged or invalidated ticket")
      admitted++
      return { operationId, targetId: value.targetId, viewNonce: "nonce:binding", observerInstanceRef: "observer:binding",
        expectedCoverageStartCursor: "cursor:start", baselineCursor: "cursor:start", baselineNextSequence: 1,
        observedCursor: "cursor:start", observedNextSequence: 1, admissionCursor: "cursor:start", admissionNextSequence: 1, expiresAt: value.expiresAt! }
    },
    async settleOperation() {},
    invalidateView(value) { retired++; invalidated.add(value); if (forgotten.has(value)) throw new Error("View ticket не принадлежит этой lineage") },
  }
  const bindings = new AgentViewBindings(core, { forLineage: () => scope })
  const authorize = core.bindNativeViewAdmission(bindings.authorizeNative)
  let nativeProof: NativeViewAdmission | undefined
  const run = (clientRequestId: string, options: { gate?: Promise<void>, admitted?: () => void, mode?: "ui-action" | "keyboard", signal?: AbortSignal } = {}) => core.runOperation(session, runtimeOperationIntentSchema.parse({
    intent: "mutation", clientRequestId, precondition: { target, inventoryId: "inventory:view-bind", inventoryRevision: 1 },
    deadlineAt: new Date(Date.now() + 5000).toISOString(), requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
  }), {}, async context => {
    if (context.wire.kind !== "native") throw new Error("Native expected")
    nativeProof = await authorize(context.wire, options.mode === "keyboard" ? { method: "input.execute", actionKind: "text" } : { method: "ax.press" })
    options.admitted?.()
    await options.gate
    throw new Error("Fixture ends before native dispatch")
  }, options.signal)
  return { core, session, target, bindings, run,
    forgetLatest: () => forgotten.add(ticket!),
    assertLatestActionable: () => scope.admit(ticket!, "operation:latest"),
    get nativeProof() { return nativeProof }, get admitted() { return admitted }, get retired() { return retired } }
}

test("только private request association приводит actual Core operation к guard ticket", async () => {
  const value = fixture()
  try {
    await value.bindings.observe(value.session, "target:bound", value.target, async () => ({ complete: true }), result => result.complete)
    const result = await value.bindings.run(value.session, "target:bound", "request:bound", "ui-action", () => value.run("request:bound"))
    expect(value.admitted).toBe(1)
    expect(result.operation.outcome.effect.state).toBe("unverified")
    expect(value.retired).toBe(1)
    expect(value.nativeProof).toMatchObject({ version: "1", viewNonce: "nonce:binding" })
    expect(value.nativeProof?.contextSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(value.nativeProof).not.toHaveProperty("targetId")
    await expect(value.bindings.run(value.session, "target:bound", "request:next", "ui-action", async () => ({}))).rejects.toThrow("fresh observe")
  } finally { await value.core.closeClientLifecycle() }
})

test("несвязанный clientRequestId не получает view proof даже при известном target", async () => {
  const value = fixture()
  try {
    await value.bindings.observe(value.session, "target:bound", value.target, async () => true, result => result)
    const result = await value.bindings.run(value.session, "target:bound", "request:bound", "ui-action", () => value.run("request:foreign"))
    expect(value.admitted).toBe(0)
    expect(result.operation.state).not.toBe("completed")
    expect(await value.core.getOperationByRequest(value.session, "request:foreign")).toBeDefined()
  } finally { await value.core.closeClientLifecycle() }
})

test("неполный observe не даёт ticket и другая lineage не использует view", async () => {
  const value = fixture()
  try {
    await value.bindings.observe(value.session, "target:bound", value.target, async () => false, result => result)
    await expect(value.bindings.run(value.session, "target:bound", "request:missing", "ui-action", async () => ({}))).rejects.toThrow("fresh observe")
    await value.bindings.observe(value.session, "target:bound", value.target, async () => true, result => result)
    const other = value.core.openClient("principal:view-bind").session
    await expect(value.bindings.run(other, "target:bound", "request:other", "ui-action", async () => ({}))).rejects.toThrow("fresh observe")
  } finally { await value.core.closeClientLifecycle() }
})

for (const scenario of ["ui-action", "cancelled-ui", "keyboard"] as const) {
  test(`pending old ${scenario} не отзывает заменивший его fresh observe`, async () => {
    const value = fixture()
    let release!: () => void
    let admitted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { admitted = resolve })
    const caller = new AbortController()
    const mode = scenario === "keyboard" ? "keyboard" : "ui-action"
    try {
      await value.bindings.observe(value.session, "target:bound", value.target, async () => true, result => result)
      const pending = value.bindings.run(value.session, "target:bound", "request:old", mode,
        () => value.run("request:old", { gate, admitted, mode, signal: caller.signal }))
      await started
      await value.bindings.observe(value.session, "target:bound", value.target, async () => true, result => result)
      if (scenario === "cancelled-ui") caller.abort(new Error("old action cancelled"))
      release()
      await pending
      const proof = await value.bindings.run(value.session, "target:bound", "request:latest", "ui-action", value.assertLatestActionable)
      expect(proof.operationId).toBe("operation:latest")
      expect(value.retired).toBe(2)
    } finally {
      release()
      await value.core.closeClientLifecycle()
    }
  })
}

for (const check of ["recover", "reject-action"] as const) {
  test(`retirement failure ${check}`, async () => {
    const value = fixture()
    const observe = () => value.bindings.observe(value.session, "target:bound", value.target, async () => true, result => result)
    try {
      await observe()
      value.forgetLatest()
      await expect(observe()).rejects.toThrow("View ticket не принадлежит этой lineage")
      if (check === "recover") {
        await expect(observe()).resolves.toBe(true)
        await value.assertLatestActionable()
      } else {
        let invoked = false
        await expect(value.bindings.run(value.session, "target:bound", "request:after-retire", "ui-action", async () => { invoked = true; return {} })).rejects.toThrow("fresh observe")
        expect(invoked).toBe(false)
      }
    } finally { await value.core.closeClientLifecycle() }
  })
}
