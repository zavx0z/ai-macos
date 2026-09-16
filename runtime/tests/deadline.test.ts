import { expect, test } from "bun:test"
import { z } from "@meta/shared/contracts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"
import { operationDeadline, signalDeadline } from "../src/deadline.ts"

test("вложенный метод наследует deadline без собственного короткого таймера", async () => {
  const core = new RuntimeCore({ generation: { runtimeEpoch: "runtime:deadline", loginSessionId: "login:deadline" }, runtimeBuildId: "build:deadline" })
  const session = core.openClient("principal:deadline").session
  const methods = new MethodRegistry(core)
  let parent: number | undefined
  methods.register("inner", {
    title: "Внутренний", description: "Проверка наследования", readOnly: true, visibility: "internal", timeoutMs: 1,
    input: z.strictObject({}), output: z.strictObject({ done: z.literal(true) }),
    async execute(context) {
      expect(signalDeadline(context.signal)).toBe(parent!)
      expect(Date.parse(operationDeadline(context.signal, 10))).toBe(parent!)
      await Bun.sleep(10)
      return { done: true }
    },
  })
  methods.register("outer", {
    title: "Внешний", description: "Единый срок", readOnly: true, timeoutMs: 1_000,
    input: z.strictObject({}), output: z.strictObject({ done: z.literal(true) }),
    async execute(context) {
      parent = signalDeadline(context.signal)
      return (await methods.internal.dispatch(session, "inner", {}, context.signal)).data as { done: true }
    },
  })
  const result = await methods.dispatch(session, "outer", {}, new AbortController().signal)
  expect(result.data).toEqual({ done: true })
})
