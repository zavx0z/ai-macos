import { expect, test } from "bun:test"
import { shutdownRuntimeHost } from "../src/server.ts"

test("shutdown вызывает close после rejected drain и сохраняет исходную ошибку", async () => {
  const calls: string[] = []
  const drainFailure = new Error("permission SDK request still running")
  let failure: unknown
  try {
    await shutdownRuntimeHost({
      async drain() { calls.push("drain"); throw drainFailure },
      async close() { calls.push("close") },
    })
  } catch (error) { failure = error }
  expect(calls).toEqual(["drain", "close"])
  expect(failure).toBeInstanceOf(AggregateError)
  const errors = (failure as AggregateError).errors as Error[]
  expect(errors).toHaveLength(1)
  expect(errors[0]?.message).toContain("drain")
  expect(errors[0]?.cause).toBe(drainFailure)
})

test("shutdown сохраняет независимые drain и close failures", async () => {
  const drainFailure = new Error("cleanup unknown")
  const closeFailure = new Error("owned exit unknown")
  let failure: unknown
  try {
    await shutdownRuntimeHost({
      async drain() { throw drainFailure },
      async close() { throw closeFailure },
    })
  } catch (error) { failure = error }
  const errors = (failure as AggregateError).errors as Error[]
  expect(errors.map(error => error.message)).toEqual(["Runtime drain не подтверждён", "Runtime close не подтверждён"])
  expect(errors.map(error => error.cause)).toEqual([drainFailure, closeFailure])
})

test("успешный drain и close завершают shutdown без ошибки", async () => {
  const calls: string[] = []
  await expect(shutdownRuntimeHost({ async drain() { calls.push("drain") }, async close() { calls.push("close") } })).resolves.toBeUndefined()
  expect(calls).toEqual(["drain", "close"])
})

test("ошибка lifecycle log не блокирует drain/close и сохраняется вместе с ними", async () => {
  const calls: string[] = []
  const logFailure = new Error("disk unavailable")
  let failure: unknown
  try {
    await shutdownRuntimeHost({
      async noteLifecycle() { calls.push("log"); throw logFailure },
      async drain() { calls.push("drain") }, async close() { calls.push("close") },
    }, "SIGTERM")
  } catch (error) { failure = error }
  expect(calls).toEqual(["log", "drain", "close"])
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toMatchObject([{ cause: logFailure }])
})
