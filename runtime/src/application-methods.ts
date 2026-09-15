import {
  adapterResultSchema,
  applicationBundleResolutionSchema,
  applicationLaunchRequestSchema,
  applicationLaunchResultSchema,
  applicationQuitRequestSchema,
  applicationQuitResultSchema,
  applicationResolveRequestSchema,
  opaqueIdSchema,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  z,
  type AdapterControl,
  type AdapterResult,
  type ApplicationBundleResolution,
  type ApplicationLaunchRequest,
  type ApplicationLaunchResult,
  type ApplicationQuitRequest,
  type ApplicationQuitResult,
  type ApplicationResolveRequest,
  type NativeExecutionContext,
  type RuntimeOperationContext,
  type ApplicationAdapter,
} from "@meta/shared/contracts"
import type { RuntimeCore } from "./core.ts"
import type { MethodRegistry } from "./method-registry.ts"

export type RuntimeApplicationAdapter = Pick<ApplicationAdapter, "resolve" | "launch" | "quit">

const mutationInput = {
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  clientRequestId: opaqueIdSchema,
}

/** Регистрирует resolve и lifecycle приложений без принятия caller-created process identity. */
export function registerApplicationMethods(
  registry: MethodRegistry,
  core: RuntimeCore,
  applications: RuntimeApplicationAdapter,
): void {
  registry.register("resolve_application", {
    title: "Найти приложение",
    description: "Проверяет exact absolute bundle path и bundle identifier, затем возвращает native-issued bundle identity для launch.",
    input: applicationResolveRequestSchema,
    output: applicationBundleResolutionSchema,
    readOnly: true,
    timeoutMs: 6000,
    requiredCapabilities: ["desktop.application.lifecycle"],
    async execute(context, request) {
      return applications.resolve(request, control(context.signal))
    },
  })

  registry.register("launch_application", {
    title: "Запустить приложение",
    description: "Запускает resolved bundle. Unknown сохраняется как operation error; candidate доступен в error.context.target, повтор clientRequestId не повторяет launch.",
    input: z.strictObject({ ...mutationInput, request: applicationLaunchRequestSchema }),
    output: z.strictObject({
      operation: operationRecordSchema,
      result: adapterResultSchema(applicationLaunchResultSchema),
    }),
    readOnly: false,
    destructive: true,
    timeoutMs: 8000,
    requiredCapabilities: ["desktop.application.lifecycle"],
    async execute(context, input) {
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: input.clientRequestId,
        precondition: {
          target: { kind: "application-bundle", ref: input.request.bundle },
          inventoryId: input.inventoryId,
          inventoryRevision: input.inventoryRevision,
        },
        deadlineAt: new Date(Date.now() + 6000).toISOString(),
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return core.runOperation(context.session, intent, input.request, (operation, request) => {
        if (operation.wire.kind !== "native") throw new Error("Application launch требует native context")
        return applications.launch(operation as RuntimeOperationContext<NativeExecutionContext>, request)
      }, context.signal)
    },
    isError: output => !output.result.ok || output.result.value.state === "unknown",
  })

  registry.register("quit_application", {
    title: "Завершить приложение",
    description: "Запрашивает quit exact process identity. still-running возвращается явно и требует внимания; unknown сохраняется как operation error.",
    input: z.strictObject({ ...mutationInput, request: applicationQuitRequestSchema }),
    output: z.strictObject({
      operation: operationRecordSchema,
      result: adapterResultSchema(applicationQuitResultSchema),
    }),
    readOnly: false,
    destructive: true,
    timeoutMs: 8000,
    requiredCapabilities: ["desktop.application.lifecycle"],
    async execute(context, input) {
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: input.clientRequestId,
        precondition: {
          target: { kind: "application", ref: input.request.application },
          inventoryId: input.inventoryId,
          inventoryRevision: input.inventoryRevision,
        },
        deadlineAt: new Date(Date.now() + 6000).toISOString(),
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return core.runOperation(context.session, intent, input.request, (operation, request) => {
        if (operation.wire.kind !== "native") throw new Error("Application quit требует native context")
        return applications.quit(operation as RuntimeOperationContext<NativeExecutionContext>, request)
      }, context.signal)
    },
    isError: output => !output.result.ok || output.result.value.state !== "terminated",
  })
}

function control(signal: AbortSignal) {
  return { signal, checkpoint() { signal.throwIfAborted() } }
}
