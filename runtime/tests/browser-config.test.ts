import { expect, test } from "bun:test"
import { parseBrowserHostConfig } from "../src/browser-config.ts"

test("browser config не включает Android или Chrome без explicit values", () => {
  expect(parseBrowserHostConfig(undefined)).toEqual({})
  const instance = { browserInstanceRef: "browser:configured", initialTransportGeneration: "transport:initial",
    endpointHost: "127.0.0.1", endpointPort: 9222, profilePath: "/tmp/configured-profile" }
  expect(parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances: [instance] } })).android).toBeUndefined()
  expect(() => parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances: [instance, instance] } }))).toThrow("duplicate")
  expect(() => parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances: [{ ...instance, endpointHost: "remote.example" }] } }))).toThrow()
  expect(() => parseBrowserHostConfig(JSON.stringify({ launchChrome: true }))).toThrow()
  expect(() => parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances: [
    instance, { ...instance, browserInstanceRef: "browser:alias", endpointHost: "localhost" },
  ] } }))).toThrow("duplicate endpoint")
  expect(() => parseBrowserHostConfig(JSON.stringify({ chrome: { bindingId: "chrome", instances: [
    { ...instance, initialTransportGeneration: "x".repeat(65) },
  ] } }))).toThrow()
})
