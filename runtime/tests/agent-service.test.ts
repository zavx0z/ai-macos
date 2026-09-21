import { expect, test } from "bun:test"
import { hostname } from "node:os"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { registerAgentService } from "../src/agent-service.ts"
import { computerActions } from "../src/agent-actions.ts"
import { signalDeadline } from "../src/deadline.ts"
import { z } from "../../shared/src/contracts/schema.ts"

function fixture() {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:agent-gate", loginSessionId: "login:agent-gate" }, runtimeBuildId: "build:agent-gate" })
  const registry = new MethodRegistry(core)
  const calls: string[] = []
  for (const name of computerActions) registry.register(name, {
    title: name, description: "isolated spy", input: z.record(z.string(), z.json()), output: z.record(z.string(), z.json()), readOnly: true,
    async execute() { calls.push(name); return {} },
  })
  registerAgentService(registry, core, { expectedHostname: hostname() })
  const session = core.openClient("principal:agent-gate").session
  return { core, registry, calls, run: (action: string, input: Record<string, unknown>, allowedActions?: string[]) => registry.dispatch(session, "agent_request", {
    node: "computer", action, input, ...(allowedActions === undefined ? {} : { allowedActions }),
  }, new AbortController().signal) }
}

test("server gateway rejects forbidden browser operations before child dispatch", async () => {
  const f = fixture()
  for (const kind of ["evaluate", "navigate-target", "close-target", "cdp-command"]) {
    await expect(f.run("browser_chrome_operation", { request: { kind } })).rejects.toThrow("разрешены только")
  }
  expect(f.calls).toEqual([])
  await f.run("browser_chrome_operation", { request: { kind: "read-resource" } })
  expect(f.calls).toEqual(["browser_chrome_operation"])
})

test("server gateway checks entire pipeline and narrowed child permissions before the prefix", async () => {
  const f = fixture()
  await expect(f.run("run_pipeline", { steps: [{ kind: "wait" }, { kind: "evaluate" }] })).rejects.toThrow("неизвестный вид шага")
  await expect(f.run("run_pipeline", { steps: [{ kind: "wait" }, { kind: "press" }] }, computerActions.filter(a => a !== "click"))).rejects.toThrow("операция click отсутствует")
  await expect(f.run("run_pipeline", { steps: [{ kind: "chrome-read", mode: "evaluate" }] })).rejects.toThrow("режим чтения")
  expect(f.calls).toEqual([])
  await f.run("run_pipeline", { steps: [{ kind: "wait" }] })
  expect(f.calls).toEqual(["run_pipeline"])
})

test("agent envelope does not extend a child method deadline", async () => {
  const f = fixture()
  let deadline: number | undefined
  let aborted = false
  f.registry.register("short_child", {
    agent: true, title: "Short child", description: "Fixture", input: z.strictObject({}), output: z.strictObject({}), readOnly: true, timeoutMs: 25,
    async execute(context) {
      deadline = signalDeadline(context.signal)
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { aborted = true; resolve() }, { once: true }))
      return {}
    },
  })
  const start = Date.now()
  await expect(f.run("short_child", {})).rejects.toThrow("отменён")
  expect(aborted).toBe(true)
  expect(deadline! - start).toBeLessThan(500)
})

test("an agent reply preserves child error flag, operation evidence and frame refs", async () => {
  const f = fixture()
  f.registry.register("evidence_child", {
    agent: true, title: "Evidence", description: "Fixture", input: z.strictObject({}), output: z.strictObject({ operationId: z.string(), reason: z.string() }), readOnly: true,
    execute: async () => ({ operationId: "operation:fixture", reason: "partial" }),
    frames: () => ["frame:fixture"], isError: () => true,
  })
  const result = await f.run("evidence_child", {})
  expect(result).toMatchObject({ isError: true, frameRefs: ["frame:fixture"], data: { payload: { operationId: "operation:fixture", reason: "partial" }, isError: true } })
})
