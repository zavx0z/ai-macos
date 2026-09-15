import { generationIdSchema, opaqueIdSchema, parseWireJson, z } from "@meta/shared/contracts"
import type { BrowserHostConfig } from "./browser-host.ts"

const configSchema = z.strictObject({
  chrome: z.strictObject({
    bindingId: opaqueIdSchema,
    instances: z.array(z.strictObject({
      browserInstanceRef: opaqueIdSchema, initialTransportGeneration: generationIdSchema,
      endpointHost: z.enum(["127.0.0.1", "localhost", "::1"]), endpointPort: z.number().int().min(1).max(65535),
      profilePath: z.string().min(1).max(4096).startsWith("/"), profileLabel: z.string().min(1).max(256).optional(),
    })).min(1).max(128),
  }).optional(),
  android: z.strictObject({
    bindingId: opaqueIdSchema, serial: z.string().min(1).max(256), localPort: z.number().int().min(1).max(65535),
    deviceRef: opaqueIdSchema, initialDeviceTransportGeneration: generationIdSchema,
    browserInstanceRef: opaqueIdSchema, initialBrowserTransportGeneration: generationIdSchema,
  }).optional(),
})

/** Только явная конфигурация существующих endpoints; не запускает Chrome или ADB. */
export function parseBrowserHostConfig(text: string | undefined): BrowserHostConfig {
  if (text === undefined) return {}
  const config = parseWireJson(configSchema, text, { maxBytes: 64 * 1024, maxDepth: 8 })
  const refs = config.chrome?.instances.map(instance => instance.browserInstanceRef) ?? []
  if (new Set(refs).size !== refs.length) throw new Error("Chrome config содержит duplicate browserInstanceRef")
  // Все разрешённые host names относятся к локальной машине; aliases одного
  // порта не должны создавать два независимых owner для одного Chrome.
  const endpoints = config.chrome?.instances.map(instance => instance.endpointPort) ?? []
  if (new Set(endpoints).size !== endpoints.length) throw new Error("Chrome config содержит duplicate endpoint")
  if (config.chrome !== undefined && config.chrome.bindingId === config.android?.bindingId) throw new Error("Browser binding IDs должны различаться")
  return config
}
