import { describe, expect, test } from "bun:test"
import { CdpBrowserDriver } from "@meta/chrome/adapter"
import { ExistingChromeDriver } from "@meta/chrome/existing-session"
import { parseBrowserHostConfig } from "../src/browser-config.ts"
import { chromeDriver, chromePersistence, chromeProvenance, type ChromeInstanceConfig } from "../src/chrome-host-config.ts"
import { lifetimeBindingPersistenceSchema, lifetimeConfigFingerprint, lifetimePhysicalOwnershipKeySchema } from "../src/lifetime-state.ts"

const existing = {
  browserInstanceRef: "browser:existing", initialTransportGeneration: "transport:initial",
  connectionMode: "existing-session" as const, userDataDir: "/tmp/test-chrome-user-data", profileLabel: "User Chrome",
}
const http = {
  browserInstanceRef: "browser:http", initialTransportGeneration: "transport:initial",
  endpointHost: "127.0.0.1" as const, endpointPort: 9222, profilePath: "/tmp/classic-cdp-profile",
}
const parse = (...instances: unknown[]) => parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances } }))

describe("existing Chrome runtime configuration", () => {
  test("new mode requires no static endpoint and config parsing does not discover or connect", () => {
    expect(parse(existing).chrome?.instances).toEqual([existing])
    expect(parseBrowserHostConfig(undefined)).toEqual({})
    expect(chromeDriver(existing)).toBeInstanceOf(ExistingChromeDriver)
  })

  test("legacy HTTP config and lifetime fingerprint remain compatible", () => {
    expect(parse(http).chrome?.instances).toEqual([http])
    expect(chromeDriver(http)).toBeInstanceOf(CdpBrowserDriver)
    const configuration = { endpointHost: http.endpointHost, endpointPort: http.endpointPort, profilePath: http.profilePath }
    expect(chromePersistence(http)).toEqual({
      owner: { kind: "browser", browserInstanceRef: http.browserInstanceRef },
      configFingerprint: lifetimeConfigFingerprint(configuration),
      physicalOwnershipKey: { kind: "chrome-cdp", ...configuration },
    })
    expect(chromeProvenance(http)).toEqual({ kind: "local-cdp", ...configuration })
  })

  test("existing-session lifetime binds the configured directory, not a guessed port", () => {
    const value = chromePersistence(existing)
    expect(value.physicalOwnershipKey).toEqual({ kind: "chrome-user-session", userDataDir: existing.userDataDir })
    expect(lifetimeBindingPersistenceSchema.parse(value)).toEqual(value)
    expect(chromeProvenance(existing)).toEqual({ kind: "external-cdp", endpointRef: existing.browserInstanceRef })
    expect(lifetimePhysicalOwnershipKeySchema.safeParse({ kind: "chrome-user-session", userDataDir: "relative" }).success).toBe(false)
  })

  test("normalizes lexical paths and rejects duplicate userDataDir owners", () => {
    const normalized = parse({ ...existing, userDataDir: "/tmp/a/../test-chrome-user-data/" }).chrome!.instances[0]!
    expect(normalized).toEqual(existing)
    expect(() => parse(existing, { ...existing, browserInstanceRef: "browser:duplicate", userDataDir: "/tmp/./test-chrome-user-data/" })).toThrow("duplicate userDataDir")
    expect(() => parse(existing, { ...existing, userDataDir: "/tmp/other" })).toThrow("duplicate browserInstanceRef")
  })

  test("rejects mixed endpoint configuration and implicit launch options", () => {
    for (const value of [
      { ...existing, endpointPort: 9222 },
      { ...existing, userDataDir: "relative" },
      { ...existing, approvalTimeoutMs: 25_001 },
      { ...existing, launchChrome: true },
      { ...existing, connectionMode: "auto-launch" },
    ]) expect(() => parse(value)).toThrow()
    expect(() => parse(existing, { ...http, profilePath: existing.userDataDir })).toThrow("both connection modes")
    expect(() => parse(http, { ...http, browserInstanceRef: "browser:http-alias", endpointHost: "localhost" })).toThrow("duplicate endpoint")
  })

  test("keeps explicit test driver injection without constructing another transport", () => {
    const driver = new CdpBrowserDriver({} as ConstructorParameters<typeof CdpBrowserDriver>[0])
    const configuration: ChromeInstanceConfig = { ...existing, driver }
    expect(chromeDriver(configuration)).toBe(driver)
  })
})
