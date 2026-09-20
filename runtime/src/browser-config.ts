import { normalize } from "node:path"
import { generationIdSchema, opaqueIdSchema, parseWireJson, z } from "@meta/shared/contracts"
import type { BrowserHostConfig } from "./browser-host.ts"

const chromeBase = {
  browserInstanceRef: opaqueIdSchema,
  initialTransportGeneration: generationIdSchema,
  profileLabel: z.string().min(1).max(256).optional(),
}
const chromeInstanceSchema = z.union([
  z.strictObject({
    ...chromeBase,
    connectionMode: z.literal("http").optional(),
    endpointHost: z.enum(["127.0.0.1", "localhost", "::1"]),
    endpointPort: z.number().int().min(1).max(65535),
    profilePath: z.string().min(1).max(4096).startsWith("/"),
  }),
  z.strictObject({
    ...chromeBase,
    connectionMode: z.literal("existing-session"),
    userDataDir: z.string().min(1).max(4096).startsWith("/"),
    approvalTimeoutMs: z.number().int().min(1).max(25_000).optional(),
  }),
])

const configSchema = z.strictObject({
  chrome: z.strictObject({
    bindingId: opaqueIdSchema,
    instances: z.array(chromeInstanceSchema).min(1).max(128),
  }).optional(),
  android: z.strictObject({
    bindingId: opaqueIdSchema, serial: z.string().min(1).max(256), localPort: z.number().int().min(1).max(65535),
    deviceRef: opaqueIdSchema, initialDeviceTransportGeneration: generationIdSchema,
    browserInstanceRef: opaqueIdSchema, initialBrowserTransportGeneration: generationIdSchema,
  }).optional(),
})

/** Pure config validation: no discovery, connection, permission prompt, Chrome launch or ADB launch. */
export function parseBrowserHostConfig(text: string | undefined): BrowserHostConfig {
  if (text === undefined) return {}
  const config = parseWireJson(configSchema, text, { maxBytes: 64 * 1024, maxDepth: 8 })
  const instances = config.chrome?.instances ?? []
  const refs = instances.map(instance => instance.browserInstanceRef)
  if (new Set(refs).size !== refs.length) throw new Error("Chrome config содержит duplicate browserInstanceRef")
  const endpoints = instances.flatMap(instance => instance.connectionMode === "existing-session" ? [] : [instance.endpointPort])
  if (new Set(endpoints).size !== endpoints.length) throw new Error("Chrome config содержит duplicate endpoint")
  const selected = new Set<string>()
  for (const instance of instances) {
    if (instance.connectionMode !== "existing-session") continue
    instance.userDataDir = normalize(instance.userDataDir).replace(/\/$/, "") || "/"
    if (selected.has(instance.userDataDir)) throw new Error("Chrome config содержит duplicate userDataDir")
    selected.add(instance.userDataDir)
  }
  for (const instance of instances) {
    if (instance.connectionMode !== "existing-session" && selected.has(normalize(instance.profilePath).replace(/\/$/, "") || "/")) {
      throw new Error("Chrome config assigns both connection modes to the same selected directory")
    }
  }
  if (config.chrome !== undefined && config.chrome.bindingId === config.android?.bindingId) throw new Error("Browser binding IDs должны различаться")
  return config
}
