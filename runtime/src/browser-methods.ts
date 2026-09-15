import {
  adapterResultSchema,
  browserInstanceRefSchema,
  browserInstanceSnapshotSchema,
  captureClipSchema,
  captureOutputPolicySchema,
  browserOperationRequestSchema,
  browserOperationResources,
  browserOperationResultSchema,
  browserTargetSnapshotSchema,
  browserTargetRefSchema,
  deviceBrowserInstanceRefSchema,
  deviceBrowserInstanceSnapshotSchema,
  deviceBrowserOperationRequestSchema,
  deviceBrowserOperationResources,
  deviceBrowserOperationResultSchema,
  deviceBrowserTargetSnapshotSchema,
  deviceBrowserTargetRefSchema,
  deviceRefSchema,
  deviceSnapshotSchema,
  lifetimeReservationHandleSchema,
  operationRecordSchema,
  operationTargetSchema,
  readinessPolicySchema,
  runtimeOperationIntentSchema,
  structurallyEqual,
  z,
  type BrowserAdapter,
  type BrowserOperationRequest,
  type DeviceBrowserAdapter,
  type DeviceBrowserOperationRequest,
  type RuntimeClientSession,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry } from "./method-registry.ts"

const browserCaptureMethodRequestSchema = z.strictObject({
  kind: z.literal("capture-target"),
  target: browserTargetRefSchema,
  capture: z.strictObject({
    source: z.literal("browser-viewport"),
    caption: z.string().min(1).max(2_048),
    target: z.strictObject({ kind: z.literal("browser-target"), ref: browserTargetRefSchema }),
    clip: captureClipSchema,
    fullPage: z.boolean(),
    cursor: z.literal("exclude"),
    readinessPolicy: readinessPolicySchema,
    output: captureOutputPolicySchema,
  }),
}).superRefine((request, context) => {
  if (!structurallyEqual(request.target, request.capture.target.ref)) {
    context.addIssue({ code: "custom", path: ["capture", "target"], message: "Capture содержит другой exact target" })
  }
  if (request.capture.fullPage && request.capture.clip.kind !== "full-target") {
    context.addIssue({ code: "custom", path: ["capture", "clip"], message: "fullPage требует full-target clip" })
  }
})
const deviceCaptureMethodRequestSchema = z.strictObject({
  kind: z.literal("capture-target"),
  target: deviceBrowserTargetRefSchema,
  capture: z.strictObject({
    source: z.literal("device-browser-viewport"),
    caption: z.string().min(1).max(2_048),
    target: z.strictObject({ kind: z.literal("device-browser-target"), ref: deviceBrowserTargetRefSchema }),
    clip: captureClipSchema,
    fullPage: z.boolean(),
    cursor: z.literal("exclude"),
    readinessPolicy: readinessPolicySchema,
    output: captureOutputPolicySchema,
  }),
}).superRefine((request, context) => {
  if (!structurallyEqual(request.target, request.capture.target.ref)) {
    context.addIssue({ code: "custom", path: ["capture", "target"], message: "Capture содержит другой exact target" })
  }
  if (request.capture.fullPage && request.capture.clip.kind !== "full-target") {
    context.addIssue({ code: "custom", path: ["capture", "clip"], message: "fullPage требует full-target clip" })
  }
})
export type BrowserCaptureMethodRequest = z.infer<typeof browserCaptureMethodRequestSchema>
export type DeviceCaptureMethodRequest = z.infer<typeof deviceCaptureMethodRequestSchema>
const browserNonCaptureOptions = browserOperationRequestSchema.options.filter(option => option.shape.kind.value !== "capture-target")
const deviceNonCaptureOptions = deviceBrowserOperationRequestSchema.options.filter(option => option.shape.kind.value !== "capture-target")
if (browserNonCaptureOptions.length < 2 || deviceNonCaptureOptions.length < 2) throw new Error("Browser public operation leaves unavailable")
const browserNonCaptureRequestSchema = z.union(browserNonCaptureOptions as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) as z.ZodType<Exclude<BrowserOperationRequest, { kind: "capture-target" }>>
const deviceNonCaptureRequestSchema = z.union(deviceNonCaptureOptions as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) as z.ZodType<Exclude<DeviceBrowserOperationRequest, { kind: "capture-target" }>>
const publicBrowserOperationRequestSchema = z.union([
  browserNonCaptureRequestSchema,
  browserCaptureMethodRequestSchema,
])
const publicDeviceOperationRequestSchema = z.union([
  deviceNonCaptureRequestSchema,
  deviceCaptureMethodRequestSchema,
])

export type BrowserBinding = {
  bindingId: string
  adapter: BrowserAdapter
  reserveCapture(
    session: RuntimeClientSession,
    intent: z.infer<typeof runtimeOperationIntentSchema>,
    request: BrowserCaptureMethodRequest,
  ): Promise<Extract<BrowserOperationRequest, { kind: "capture-target" }>>
}

export type DeviceBinding = {
  bindingId: string
  adapter: DeviceBrowserAdapter
  reserveCapture(
    session: RuntimeClientSession,
    intent: z.infer<typeof runtimeOperationIntentSchema>,
    request: DeviceCaptureMethodRequest,
  ): Promise<Extract<DeviceBrowserOperationRequest, { kind: "capture-target" }>>
}

export type BrowserMethodBindings = {
  browser?: BrowserBinding
  device?: DeviceBinding
}

const browserExecutionSchema = z.strictObject({
  operation: operationRecordSchema,
  result: adapterResultSchema(browserOperationResultSchema),
})

const deviceExecutionSchema = z.strictObject({
  operation: operationRecordSchema,
  result: adapterResultSchema(deviceBrowserOperationResultSchema),
})

export function registerBrowserMethods(
  registry: MethodRegistry,
  runtime: RuntimeCore,
  bindings: BrowserMethodBindings,
): void {
  if (bindings.browser !== undefined) registerChromeMethods(registry, runtime, bindings.browser)
  if (bindings.device !== undefined) registerAndroidMethods(registry, runtime, bindings.device)
}

function registerChromeMethods(registry: MethodRegistry, runtime: RuntimeCore, binding: BrowserBinding): void {
  registry.register("browser_chrome_instances", {
    title: "Chrome instances",
    description: "Возвращает полный snapshot явно настроенных Chrome instances",
    input: z.strictObject({}),
    output: browserInstanceSnapshotSchema,
    readOnly: true,
    requiredCapabilities: ["browser.instances"],
    execute: context => binding.adapter.listInstances(control(context.signal)),
  })
  registry.register("browser_chrome_targets", {
    title: "Chrome targets",
    description: "Возвращает exact targets активного Chrome instance",
    input: z.strictObject({ instance: browserInstanceRefSchema }),
    output: browserTargetSnapshotSchema,
    readOnly: true,
    requiredCapabilities: ["browser.targets"],
    async execute(context, input) {
      await requireActiveReservation(runtime, context.session, { kind: "browser-instance", ref: input.instance })
      return await binding.adapter.listTargets(input.instance, control(context.signal))
    },
  })
  registry.register("browser_chrome_operation", {
    title: "Chrome operation",
    description: "Выполняет exact Chrome operation через lifetime coordinator",
    input: z.strictObject({ intent: runtimeOperationIntentSchema, request: publicBrowserOperationRequestSchema }),
    output: browserExecutionSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: 30_000,
    maxRequestBytes: 8 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    requiredCapabilities: ["browser.targets", "runtime.operations"],
    async execute(context, input) {
      if (context.signal.aborted) throw new DOMException("Browser operation aborted", "AbortError")
      const request = input.request.kind === "capture-target"
        ? await binding.reserveCapture(context.session, input.intent, input.request)
        : browserOperationRequestSchema.parse(input.request)
      const intent = input.request.kind === "capture-target"
        ? runtimeOperationIntentSchema.parse({ ...input.intent, requestedResources: browserOperationResources(request) })
        : input.intent
      const execution = await runtime.browserLifetime.execute(context.session, binding.bindingId, intent, request, context.signal)
      if (request.kind === "capture-target" && execution.result.ok
        && execution.result.value.value.kind === "target-captured") {
        await runtime.commitCaptureObservation(
          context.session,
          request.capture.publication,
          execution.result.value.value.capture.observation,
        )
      }
      return execution
    },
    frames: output => frameRefs(output.result),
    isError: output => !output.result.ok,
  })
  registerLifetimeMethods(registry, runtime, "browser_chrome", "browser.instances")
  registry.register("browser_chrome_recover", {
    title: "Recover Chrome lifetime",
    description: "Освобождает exact quarantined Chrome reservation через configured verifier",
    input: z.strictObject({ intent: runtimeOperationIntentSchema }),
    output: browserExecutionSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: 30_000,
    requiredCapabilities: ["browser.instances", "runtime.operations"],
    availableDuringDrain: true,
    async execute(context, input) {
      return browserExecutionSchema.parse(await runtime.browserLifetime.recover(context.session, binding.bindingId, input.intent, context.signal))
    },
    isError: output => !output.result.ok,
  })
}

function registerAndroidMethods(registry: MethodRegistry, runtime: RuntimeCore, binding: DeviceBinding): void {
  registry.register("android_chrome_devices", {
    title: "Android devices",
    description: "Возвращает bounded Android device snapshot без выбора первого устройства",
    input: z.strictObject({}),
    output: deviceSnapshotSchema,
    readOnly: true,
    requiredCapabilities: ["android.chrome"],
    execute: context => binding.adapter.listDevices(control(context.signal)),
  })
  registry.register("android_chrome_instances", {
    title: "Android Chrome instances",
    description: "Возвращает Chrome instances точного Android device ref",
    input: z.strictObject({ device: deviceRefSchema }),
    output: deviceBrowserInstanceSnapshotSchema,
    readOnly: true,
    requiredCapabilities: ["android.chrome"],
    execute: (context, input) => binding.adapter.listInstances(input.device, control(context.signal)),
  })
  registry.register("android_chrome_targets", {
    title: "Android Chrome targets",
    description: "Возвращает exact targets активного Android Chrome instance",
    input: z.strictObject({ instance: deviceBrowserInstanceRefSchema }),
    output: deviceBrowserTargetSnapshotSchema,
    readOnly: true,
    requiredCapabilities: ["android.chrome"],
    async execute(context, input) {
      await requireActiveReservation(runtime, context.session, { kind: "device-browser-instance", ref: input.instance })
      return await binding.adapter.listTargets(input.instance, control(context.signal))
    },
  })
  registry.register("android_chrome_operation", {
    title: "Android Chrome operation",
    description: "Выполняет exact Android Chrome operation через lifetime coordinator",
    input: z.strictObject({ intent: runtimeOperationIntentSchema, request: publicDeviceOperationRequestSchema }),
    output: deviceExecutionSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: 30_000,
    maxRequestBytes: 8 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    requiredCapabilities: ["android.chrome", "runtime.operations"],
    async execute(context, input) {
      if (context.signal.aborted) throw new DOMException("Android operation aborted", "AbortError")
      const request = input.request.kind === "capture-target"
        ? await binding.reserveCapture(context.session, input.intent, input.request)
        : deviceBrowserOperationRequestSchema.parse(input.request)
      const intent = input.request.kind === "capture-target"
        ? runtimeOperationIntentSchema.parse({ ...input.intent, requestedResources: deviceBrowserOperationResources(request) })
        : input.intent
      const execution = await runtime.browserLifetime.execute(context.session, binding.bindingId, intent, request, context.signal)
      if (request.kind === "capture-target" && execution.result.ok
        && execution.result.value.value.kind === "target-captured") {
        await runtime.commitCaptureObservation(
          context.session,
          request.capture.publication,
          execution.result.value.value.capture.observation,
        )
      }
      return execution
    },
    frames: output => frameRefs(output.result),
    isError: output => !output.result.ok,
  })
  registerLifetimeMethods(registry, runtime, "android_chrome", "android.chrome")
  registry.register("android_chrome_recover", {
    title: "Recover Android Chrome lifetime",
    description: "Освобождает exact quarantined Android reservation через configured verifier",
    input: z.strictObject({ intent: runtimeOperationIntentSchema }),
    output: deviceExecutionSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: 30_000,
    requiredCapabilities: ["android.chrome", "runtime.operations"],
    availableDuringDrain: true,
    async execute(context, input) {
      return deviceExecutionSchema.parse(await runtime.browserLifetime.recover(context.session, binding.bindingId, input.intent, context.signal))
    },
    isError: output => !output.result.ok,
  })
}

function registerLifetimeMethods(
  registry: MethodRegistry,
  runtime: RuntimeCore,
  prefix: "browser_chrome" | "android_chrome",
  capability: "browser.instances" | "android.chrome",
): void {
  registry.register(`${prefix}_reservation`, {
    title: "Browser lifetime reservation",
    description: "Читает reservation только текущей authenticated lineage",
    input: z.strictObject({ target: operationTargetSchema }),
    output: z.strictObject({ reservation: lifetimeReservationHandleSchema.optional() }),
    readOnly: true,
    requiredCapabilities: [capability],
    async execute(context, input) {
      const reservation = await runtime.reservations.inspect(context.session, input.target)
      return reservation === undefined ? {} : { reservation }
    },
  })
  registry.register(`${prefix}_resume`, {
    title: "Resume browser reservation",
    description: "Возвращает active reservation только той же authenticated lineage",
    input: z.strictObject({ reservationId: z.string().min(1).max(127) }),
    output: z.strictObject({ reservation: lifetimeReservationHandleSchema }),
    readOnly: true,
    requiredCapabilities: [capability],
    async execute(context, input) {
      return { reservation: await runtime.reservations.resume(context.session, input.reservationId) }
    },
  })
}

async function requireActiveReservation(
  runtime: RuntimeCore,
  session: RuntimeClientSession,
  target: Parameters<RuntimeCore["reservations"]["inspect"]>[1],
): Promise<void> {
  const reservation = await runtime.reservations.inspect(session, target)
  if (reservation?.state !== "active") throw new Error("Exact active lifetime reservation required")
}

function control(signal: AbortSignal) {
  return {
    signal,
    checkpoint() {
      if (signal.aborted) throw new DOMException("Browser method aborted", "AbortError")
    },
  }
}

function frameRefs(result: { ok: boolean, value?: { value: { kind: string, capture?: { frame: { frameRef: string } } } } }): string[] {
  return result.ok && result.value?.value.kind === "target-captured" && result.value.value.capture !== undefined
    ? [result.value.value.capture.frame.frameRef]
    : []
}
