import { z } from "zod"
import { isoTimestampSchema } from "./schema.ts"

export const CONTRACT_SCHEMA_VERSION = "1" as const
export const RUNTIME_PROTOCOL_VERSION = "1" as const
export const NATIVE_PROTOCOL_VERSION = "1" as const

const asciiIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export const opaqueIdSchema = z.string().min(1).max(127).regex(asciiIdPattern)
  .describe("Непрозрачный ASCII ID, безопасный для native C buffer capacity 128 с NUL")
export type OpaqueId = z.infer<typeof opaqueIdSchema>

export const generationIdSchema = z.string().min(1).max(64).regex(asciiIdPattern)
  .describe("Generation ID с запасом для суффиксов native-generated refs")

export const runtimeGenerationSchema = z.strictObject({
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
})
export type RuntimeGeneration = z.infer<typeof runtimeGenerationSchema>

export const nativeGenerationSchema = runtimeGenerationSchema.extend({
  nativeGeneration: generationIdSchema,
}).strict()
export type NativeGeneration = z.infer<typeof nativeGenerationSchema>

export const fenceTokenSchema = z.strictObject({
  runtimeEpoch: generationIdSchema,
  loginSessionId: generationIdSchema,
  nativeGeneration: generationIdSchema,
  counter: z.number().int().safe().min(1),
})
export type FenceToken = z.infer<typeof fenceTokenSchema>

export const processRefSchema = nativeGenerationSchema.extend({
  applicationRef: opaqueIdSchema,
  pid: z.number().int().min(1).max(0x7fffffff),
  launchedAt: isoTimestampSchema,
  registrationNonce: generationIdSchema,
}).strict()
export type ProcessRef = z.infer<typeof processRefSchema>

export const runtimeProcessRefSchema = runtimeGenerationSchema.extend({
  processRef: opaqueIdSchema,
  pid: z.number().int().min(1).max(0x7fffffff),
  launchedAt: isoTimestampSchema,
  registrationNonce: generationIdSchema,
}).strict()
export type RuntimeProcessRef = z.infer<typeof runtimeProcessRefSchema>

export const applicationRefSchema = processRefSchema
export type ApplicationRef = ProcessRef

/** Native-issued identity установленного bundle до появления процесса. */
export const applicationBundleRefSchema = nativeGenerationSchema.extend({
  bundleRef: opaqueIdSchema,
  bundleId: z.string().min(1).max(255),
  path: z.string().min(1).max(4096).startsWith("/"),
  device: z.string().regex(/^[0-9]+$/).max(32),
  inode: z.string().regex(/^[0-9]+$/).max(32),
  modifiedAtNs: z.string().regex(/^[0-9]+$/).max(32),
}).strict()
export type ApplicationBundleRef = z.infer<typeof applicationBundleRefSchema>

export const windowRefSchema = nativeGenerationSchema.extend({
  applicationRef: opaqueIdSchema,
  windowRef: opaqueIdSchema,
}).strict()
export type WindowRef = z.infer<typeof windowRefSchema>

export const surfaceRefSchema = nativeGenerationSchema.extend({
  applicationRef: opaqueIdSchema,
  surfaceRef: opaqueIdSchema,
  ownerWindowRef: opaqueIdSchema.optional(),
}).strict()
export type SurfaceRef = z.infer<typeof surfaceRefSchema>

export const elementRefSchema = nativeGenerationSchema.extend({
  applicationRef: opaqueIdSchema,
  elementRef: opaqueIdSchema,
  snapshotId: opaqueIdSchema,
}).strict()
export type ElementRef = z.infer<typeof elementRefSchema>

export const displayRefSchema = nativeGenerationSchema.extend({
  displayRef: opaqueIdSchema,
  displayLayoutRevision: z.number().int().safe().min(0),
}).strict()
export type DisplayRef = z.infer<typeof displayRefSchema>

export const desktopLayoutRefSchema = nativeGenerationSchema.extend({
  layoutRef: opaqueIdSchema,
  displayLayoutRevision: z.number().int().safe().min(0),
}).strict()
export type DesktopLayoutRef = z.infer<typeof desktopLayoutRefSchema>

export const browserInstanceRefSchema = runtimeGenerationSchema.extend({
  browserInstanceRef: opaqueIdSchema,
  transportGeneration: generationIdSchema,
}).strict()
export type BrowserInstanceRef = z.infer<typeof browserInstanceRefSchema>

export const browserTargetRefSchema = browserInstanceRefSchema.extend({
  targetId: opaqueIdSchema,
  resourceRef: opaqueIdSchema,
}).strict()
export type BrowserTargetRef = z.infer<typeof browserTargetRefSchema>

export const deviceRefSchema = runtimeGenerationSchema.extend({
  deviceRef: opaqueIdSchema,
  serial: z.string().min(1).max(256),
  transportGeneration: generationIdSchema,
}).strict()
export type DeviceRef = z.infer<typeof deviceRefSchema>

export const deviceBrowserInstanceRefSchema = deviceRefSchema.extend({
  browserInstanceRef: opaqueIdSchema,
  browserTransportGeneration: generationIdSchema,
}).strict()
export type DeviceBrowserInstanceRef = z.infer<typeof deviceBrowserInstanceRefSchema>

export const deviceBrowserTargetRefSchema = deviceBrowserInstanceRefSchema.extend({
  targetId: opaqueIdSchema,
  resourceRef: opaqueIdSchema,
}).strict()
export type DeviceBrowserTargetRef = z.infer<typeof deviceBrowserTargetRefSchema>

export const clipboardRefSchema = runtimeGenerationSchema.extend({
  clipboardRef: z.literal("system"),
}).strict()
export type ClipboardRef = z.infer<typeof clipboardRefSchema>

export const operationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("application-bundle"), ref: applicationBundleRefSchema }),
  z.strictObject({ kind: z.literal("application"), ref: applicationRefSchema }),
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
  z.strictObject({ kind: z.literal("element"), ref: elementRefSchema }),
  z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
  z.strictObject({ kind: z.literal("desktop-layout"), ref: desktopLayoutRefSchema }),
  z.strictObject({ kind: z.literal("browser-instance"), ref: browserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("browser-target"), ref: browserTargetRefSchema }),
  z.strictObject({ kind: z.literal("device"), ref: deviceRefSchema }),
  z.strictObject({ kind: z.literal("device-browser-instance"), ref: deviceBrowserInstanceRefSchema }),
  z.strictObject({ kind: z.literal("device-browser-target"), ref: deviceBrowserTargetRefSchema }),
  z.strictObject({ kind: z.literal("clipboard"), ref: clipboardRefSchema }),
])
export type OperationTarget = z.infer<typeof operationTargetSchema>

export const nativeOperationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("application-bundle"), ref: applicationBundleRefSchema }),
  z.strictObject({ kind: z.literal("application"), ref: applicationRefSchema }),
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
  z.strictObject({ kind: z.literal("element"), ref: elementRefSchema }),
  z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
  z.strictObject({ kind: z.literal("desktop-layout"), ref: desktopLayoutRefSchema }),
])
export type NativeOperationTarget = z.infer<typeof nativeOperationTargetSchema>

export function sameRuntimeGeneration(a: RuntimeGeneration, b: RuntimeGeneration): boolean {
  return a.runtimeEpoch === b.runtimeEpoch && a.loginSessionId === b.loginSessionId
}

export function sameNativeGeneration(a: NativeGeneration, b: NativeGeneration): boolean {
  return sameRuntimeGeneration(a, b) && a.nativeGeneration === b.nativeGeneration
}

export function fenceMatchesGeneration(fence: FenceToken, generation: NativeGeneration): boolean {
  return sameNativeGeneration(fence, generation)
}

export function targetRuntimeGeneration(target: OperationTarget): RuntimeGeneration {
  return target.ref
}
