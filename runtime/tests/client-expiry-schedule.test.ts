import { expect, test } from "bun:test"
import { ClientSessionRegistry } from "../src/client-sessions.ts"

test("ближайший expiry перепланируется по изменению registry, а не polling", () => {
  const now = Date.now()
  const clients = new ClientSessionRegistry({ runtimeEpoch: "runtime:expiry", loginSessionId: "login:expiry" }, { clock: { now: () => new Date(now) } })
  const deadlines: Array<number | undefined> = []
  const unsubscribe = clients.subscribeChanged(() => { deadlines.push(clients.nextExpiryAt()) })
  const first = clients.open("first", 100)
  const second = clients.open("second", 200)
  expect(clients.nextExpiryAt()).toBe(now + 100)
  clients.disconnect(first.session.clientSessionId)
  expect(clients.nextExpiryAt()).toBe(now + 200)
  clients.revokePrincipal(second.session.principalId)
  expect(clients.nextExpiryAt()).toBeUndefined()
  expect(deadlines).toEqual([now + 100, now + 100, now + 200, undefined])
  unsubscribe()
})
