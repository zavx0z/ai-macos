import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS, browserOperationResources, runtimeOperationIntentSchema,
  type BrowserOperationRequest, type OperationRecord,
} from "@meta/shared/contracts"
import type { BrowserDriver } from "@meta/chrome/adapter"
import { registerBrowserMethods } from "../src/browser-methods.ts"
import { MethodRegistry, type RuntimeMethodResponse } from "../src/method-registry.ts"
import { browserFixture } from "./browser-fixture.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function bounded<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("connect reply still blocks on consent")), ms)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
function data(response: RuntimeMethodResponse) {
  return response.data as { operation: OperationRecord, pending?: true, result?: { ok: boolean } }
}
function setup() {
  const f = browserFixture({ clientGraceMs: 1 })
  f.runtime.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "test:connect-start",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" as const })) })
  const registry = new MethodRegistry(f.runtime)
  registerBrowserMethods(registry, f.runtime, { browser: {
    bindingId: "browser", adapter: f.adapter,
    async reserveCapture() { throw new Error("start must not reserve a capture") },
  } })
  const consent = deferred()
  const entered = deferred()
  let connectSignal: AbortSignal | undefined
  const driver: BrowserDriver = f.driver
  driver.connect = async signal => {
    f.driver.connectCalls++
    connectSignal = signal
    entered.resolve()
    let onAbort!: () => void
    try {
      await Promise.race([consent.promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("consent cancelled", "AbortError"))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      })])
      if (signal.aborted) throw new DOMException("consent cancelled", "AbortError")
      f.driver.connected = true
      return { browserVersion: "Chrome/Test" }
    } finally { signal.removeEventListener("abort", onAbort) }
  }
  const session = f.credential.session
  const request = { kind: "connect-instance" as const, instance: f.initial }
  function input(id: string, waitForCompletion?: boolean, deadlineMs = 5_000) {
    return {
      intent: runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: id,
        precondition: { target: { kind: "browser-instance", ref: f.initial }, inventoryId: "inventory:1", inventoryRevision: 1 },
        deadlineAt: new Date(Date.now() + deadlineMs).toISOString(), requestedResources: browserOperationResources(request) }),
      request,
      ...(waitForCompletion === undefined ? {} : { waitForCompletion }),
    }
  }
  const dispatch = (value: unknown, signal = new AbortController().signal) => registry.dispatch(session, "browser_chrome_operation", value, signal)
  async function terminal(id: string) {
    return bounded((async () => {
      for (;;) {
        const record = await f.runtime.getOperation(session, id)
        if (record && ["completed", "failed", "cancelled", "rejected", "interrupted-unknown"].includes(record.state)) return record
        await delay(2)
      }
    })())
  }
  async function dispose() {
    consent.resolve()
    await f.runtime.stopOperations()
    await f.runtime.browserLifetime.shutdownLineage()
    await f.runtime.closeClientLifecycle()
  }
  return { ...f, registry, consent, entered, session, input, dispatch, terminal, dispose, signal: () => connectSignal }
}

test("existing synchronous connect blocks until consent (baseline)", async () => {
  const f = setup()
  try {
    let returned = false
    const reply = f.dispatch(f.input("start:baseline")).then(result => { returned = true; return result })
    await bounded(f.entered.promise)
    await delay(10)
    expect(returned).toBe(false)
    expect(f.driver.connected).toBe(false)
    f.consent.resolve()
    const result = data(await bounded(reply))
    expect(result.operation.state).toBe("completed")
    expect(result.result?.ok).toBe(true)
    expect(result.pending).toBeUndefined()
  } finally { await f.dispose() }
})

test("connect start returns own operation before consent; polling does not reconnect", async () => {
  const f = setup()
  try {
    const caller = new AbortController()
    const reply = await bounded(f.dispatch(f.input("start:consent", false), caller.signal))
    const accepted = data(reply)
    expect(accepted.pending).toBe(true)
    expect(accepted.result).toBeUndefined()
    expect(reply.isError).toBe(false)
    expect(reply.frameRefs).toEqual([])
    const id = accepted.operation.context.operationId
    expect(accepted.operation.outcome.effect.state).toBe("unverified")
    expect(accepted.operation.clientSessionId).toBe(f.session.clientSessionId)
    await bounded(f.entered.promise)
    expect(f.runtime.activeOperationCount()).toBe(1)
    expect(f.driver.connected).toBe(false)
    for (let i = 0; i < 2; i++) {
      const record = await f.runtime.getOperation(f.session, id)
      expect(record?.context.operationId).toBe(id)
      expect(record?.state).not.toBe("completed")
      const snapshot = await f.registry.dispatch(f.session, "browser_chrome_instances", {}, new AbortController().signal)
      expect(snapshot.isError).not.toBe(true)
    }
    caller.abort("the start RPC is already finished")
    expect(f.signal()?.aborted).toBe(false)
    expect(f.driver.connectCalls).toBe(1)
    f.consent.resolve()
    expect((await f.terminal(id)).state).toBe("completed")
    const snapshot = await f.adapter.listInstances({ signal: new AbortController().signal, checkpoint() {} })
    const actual = snapshot.instances[0]!.ref
    expect(actual.transportGeneration).not.toBe(f.initial.transportGeneration)
    expect((await f.runtime.reservations.inspect(f.session, { kind: "browser-instance", ref: actual }))?.state).toBe("active")
    f.register(actual, 2)
    const disconnected = await f.invoke(f.session, "start:disconnect", { kind: "disconnect-instance", instance: actual }, 2)
    expect(disconnected.operation.state).toBe("completed")
    expect(disconnected.operation.outcome.cleanup.state).toBe("complete")
    expect(f.driver.connected).toBe(false)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("start retains its operation deadline after method timer is disposed", async () => {
  const f = setup()
  try {
    const accepted = data(await bounded(f.dispatch(f.input("start:deadline", false, 100))))
    expect(accepted.pending).toBe(true)
    await bounded(f.entered.promise)
    const record = await f.terminal(accepted.operation.context.operationId)
    expect(record.state).not.toBe("completed")
    expect(f.signal()?.aborted).toBe(true)
    expect(f.driver.connected).toBe(false)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

for (const mode of ["cancel", "disconnect-client", "drain"] as const) {
  test(`pending connect still obeys ${mode}`, async () => {
    const f = setup()
    try {
      const accepted = data(await bounded(f.dispatch(f.input(`start:${mode}`, false))))
      await bounded(f.entered.promise)
      const id = accepted.operation.context.operationId
      if (mode === "cancel") await f.runtime.cancelOperation(f.session, id, "test cancellation")
      else if (mode === "disconnect-client") f.runtime.disconnectClient(f.session.clientSessionId)
      else await f.runtime.stopOperations()
      await bounded((async () => { while (f.runtime.activeOperationCount() !== 0) await delay(2) })())
      expect(f.signal()?.aborted).toBe(true)
      expect(f.driver.connected).toBe(false)
      expect(f.driver.connectCalls).toBe(1)
      if (mode !== "disconnect-client") expect((await f.runtime.getOperation(f.session, id))?.state).not.toBe("completed")
    } finally { await f.dispose() }
  })
}

test("same request is not dispatched twice; changed payload cannot take it over", async () => {
  const f = setup()
  try {
    const input = f.input("start:dedup", false)
    const first = data(await bounded(f.dispatch(input)))
    await bounded(f.entered.promise)
    const duplicate = f.dispatch(input)
    await expect(f.dispatch({ ...input, intent: { ...input.intent, intent: "admin" } })).rejects.toThrow("payload")
    expect(f.driver.connectCalls).toBe(1)
    f.consent.resolve()
    expect(data(await bounded(duplicate)).operation.context.operationId).toBe(first.operation.context.operationId)
    expect((await f.terminal(first.operation.context.operationId)).state).toBe("completed")
    const completed = data(await bounded(f.dispatch(input)))
    expect(completed.operation.context.operationId).toBe(first.operation.context.operationId)
    expect(completed.result?.ok).toBe(true)
    expect(f.driver.connectCalls).toBe(1)
  } finally { await f.dispose() }
})

test("pending operation receipt is inaccessible to another client lineage", async () => {
  const f = setup()
  try {
    const accepted = data(await bounded(f.dispatch(f.input("start:owner", false))))
    const foreign = f.runtime.openClient("principal:foreign").session
    await expect(f.runtime.getOperation(foreign, accepted.operation.context.operationId)).rejects.toThrow("lineage")
    await expect(f.runtime.cancelOperation(foreign, accepted.operation.context.operationId, "foreign")).rejects.toThrow("lineage")
    expect(f.runtime.activeOperationCount()).toBe(1)
    f.consent.resolve()
    expect((await f.terminal(accepted.operation.context.operationId)).state).toBe("completed")
  } finally { await f.dispose() }
})

test("start rejects stale targets and wrong resources before creating a connection", async () => {
  const f = setup()
  try {
    const input = f.input("start:stale", false)
    await expect(f.dispatch({ ...input, intent: { ...input.intent, precondition: {
      ...input.intent.precondition, inventoryId: "foreign:inventory",
    } } })).rejects.toThrow()
    await expect(f.dispatch({ ...input, intent: { ...input.intent, requestedResources: [] } })).rejects.toThrow()
    expect(f.driver.connectCalls).toBe(0)
    expect(f.runtime.operationCount()).toBe(0)
  } finally { await f.dispose() }
})

test("pre-aborted start has no effect", async () => {
  const f = setup()
  try {
    const caller = new AbortController()
    caller.abort()
    await expect(f.dispatch(f.input("start:aborted", false), caller.signal)).rejects.toThrow()
    expect(f.driver.connectCalls).toBe(0)
    expect(f.runtime.operationCount()).toBe(0)
  } finally { await f.dispose() }
})

test("fast return is only allowed for connect-instance, not other browser actions", async () => {
  const f = setup()
  try {
    const request: BrowserOperationRequest = { kind: "disconnect-instance", instance: f.initial }
    await expect(f.dispatch({ ...f.input("start:not-connect", false), request })).rejects.toThrow("connect-instance")
    expect(f.runtime.operationCount()).toBe(0)
    expect(f.driver.disconnectCalls).toBe(0)
  } finally { await f.dispose() }
})
