import { expect, test } from "bun:test"
import { updateManagedProxy, type ProxyUpdateSteps } from "./chat-proxy-install.ts"

function fixture(fail?: string, rollbackFails = false) {
  const events: string[] = []
  let failed = false
  const step = (name: string) => async () => {
    events.push(name)
    if (name === fail && !failed || name === "restore" && rollbackFails) {
      failed = true
      throw new Error(name)
    }
  }
  const steps: ProxyUpdateSteps = {
    prepare: step("prepare"), stop: step("stop"), replace: step("replace"),
    start: step("start"), verify: step("verify"), restore: step("restore"),
    async record(phase) { events.push(phase) },
  }
  return { events, steps }
}

test("кандидат проверяется до остановки; заменяется только внутри остановленной session", async () => {
  const { events, steps } = fixture()
  await updateManagedProxy(steps)
  expect(events).toEqual(["prepare", "prepared", "stop", "stopped", "replace", "replaced", "start", "verify", "installed"])
})

test.each(["prepare", "stop"])("отказ %s не заменяет работающий бинарник", async stage => {
  const { events, steps } = fixture(stage)
  await expect(updateManagedProxy(steps)).rejects.toThrow(stage)
  expect(events).not.toContain("replace")
  expect(events).not.toContain("start")
})

test.each(["replace", "start", "verify"])("отказ %s возвращает прежнюю сборку и проверяет восстановление", async stage => {
  const { events, steps } = fixture(stage)
  await expect(updateManagedProxy(steps)).rejects.toThrow("прежняя копия восстановлена")
  expect(events.slice(-5)).toEqual(["stop", "restore", "start", "verify", "rolled-back"])
  expect(events.filter(value => value === "restore")).toHaveLength(1)
})

test("отказ rollback останавливает процедуру без цикла перезапусков", async () => {
  const { events, steps } = fixture("verify", true)
  await expect(updateManagedProxy(steps)).rejects.toThrow("rollback прокси не завершены")
  expect(events.slice(-2)).toEqual(["stop", "restore"])
  expect(events.filter(value => value === "start")).toHaveLength(1)
})
