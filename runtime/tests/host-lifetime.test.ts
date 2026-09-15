import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { browserOperationResources } from "@meta/shared/contracts"
import { createRuntimeHost } from "../src/host.ts"
import { FileLifetimeStore } from "../src/lifetime-state.ts"
import { sha256 } from "../src/primitives.ts"
import { FixtureBrowserDriver } from "./browser-fixture.ts"

test("RuntimeHost восстанавливает durable lifetime и запрещает повторный connect после restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-lifetime-"))
  const driver = new FixtureBrowserDriver()
  const loginSessionId = "login:host-lifetime"
  const options = {
    socketPath: join(directory, "runtime.sock"),
    credentialPath: join(directory, "credential.json"),
    stateDirectory: join(directory, "state"),
    runtimeBuildId: "build:host-lifetime",
    expectedNativeBuildId: "build:unused",
    expectedHostname: hostname(),
    loginSessionId,
    browser: { chrome: { bindingId: "browser", instances: [{
      browserInstanceRef: "browser:durable",
      initialTransportGeneration: "transport:initial",
      endpointHost: "127.0.0.1" as const,
      endpointPort: 9222,
      profilePath: "/fixture/durable-profile",
      driver,
    }] } },
  }
  const store = new FileLifetimeStore(join(options.stateDirectory, `login-${sha256(loginSessionId)}`, "lifetimes"))
  let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
  try {
    host = await createRuntimeHost(options)
    const original = await host.core.openClientDurable("principal:durable")
    const connect = (current: NonNullable<typeof host>, session: typeof original.session, clientRequestId: string) => {
      const instance = { ...current.core.generation, browserInstanceRef: "browser:durable", transportGeneration: "transport:initial" }
      const request = { kind: "connect-instance" as const, instance }
      return current.catalog.dispatch(session, "browser_chrome_operation", {
        intent: {
          intent: "mutation", clientRequestId,
          precondition: {
            target: { kind: "browser-instance", ref: instance },
            inventoryId: "browser-host:browser:browser:durable:initial", inventoryRevision: 0,
          },
          deadlineAt: new Date(Date.now() + 5_000).toISOString(),
          requestedResources: browserOperationResources(request),
        },
        request,
      }, new AbortController().signal)
    }
    const connected = await connect(host, original.session, "connect:first")
    expect(connected.data.operation).toMatchObject({ state: "completed" })
    const [persisted] = await store.loadAll()
    expect(persisted?.state).toBe("active")
    expect(driver.connectCalls).toBe(1)
    await host.close()
    host = undefined

    host = await createRuntimeHost(options)
    const resumed = await host.core.resumeClientDurable(original.resumptionToken)
    expect((await store.loadAll())[0]?.state).toBe("quarantined")
    expect(await host.core.reservations.inspect(resumed.session, persisted!.target)).toMatchObject({ state: "quarantined" })
    expect(driver.connectCalls).toBe(1)
    expect(driver.disconnectCalls).toBe(0)
    const repeated = await connect(host, resumed.session, "connect:after-restart")
    expect(repeated.data.operation).toMatchObject({ state: "rejected" })
    expect(driver.connectCalls).toBe(1)
    expect((await store.loadAll())[0]?.state).toBe("quarantined")
  } finally {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
