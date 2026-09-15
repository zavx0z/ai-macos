import { expect, test } from "bun:test"
import { ClientRenewalCoordinator } from "../src/client-renewal.ts"

test("renewal ждёт long call и coalesces concurrent callers без повторения действия", async () => {
  let now = Date.now()
  let renewals = 0
  const timing = () => ({ authenticatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() })
  const renewal = new ClientRenewalCoordinator({ now: () => now, async renew() { renewals++; return timing() } })
  renewal.setCredential(timing())
  const long = await renewal.enter(120_000)
  now += 230_000
  const first = renewal.enter(100_000)
  const second = renewal.enter(100_000)
  await Promise.resolve()
  expect(renewals).toBe(0)
  long.release()
  const leases = await Promise.all([first, second])
  expect(renewals).toBe(1)
  for (const lease of leases) lease.release()
  renewal.close()
})

test("outage renewal не допускает call; reconnect после bearer expiry обновляет credential", async () => {
  let now = Date.now()
  let online = false
  const timing = () => ({ authenticatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() })
  const renewal = new ClientRenewalCoordinator({ now: () => now, async renew() { if (!online) throw new Error("offline"); return timing() } })
  renewal.setCredential(timing())
  now += 400_000
  await expect(renewal.enter(5000)).rejects.toThrow("offline")
  online = true
  const lease = await renewal.enter(5000)
  expect(lease.signal.aborted).toBe(false)
  renewal.close()
  expect(lease.signal.aborted).toBe(true)
  lease.release()
})

test("close aborts idle waiter без renewal и действие не стартует", async () => {
  let now = Date.now()
  let renewals = 0
  const renewal = new ClientRenewalCoordinator({ now: () => now, async renew() { renewals++; throw new Error("unexpected") } })
  renewal.setCredential({ authenticatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() })
  const active = await renewal.enter(1000)
  now += 299_000
  const blocked = renewal.enter(5000)
  renewal.close()
  await expect(blocked).rejects.toThrow("закрыт")
  expect(renewals).toBe(0)
  active.release()
})
