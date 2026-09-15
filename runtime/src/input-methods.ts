import {
  adapterResultSchema,
  desktopLayoutRefSchema,
  displayRefSchema,
  observationRefSchema,
  opaqueIdSchema,
  operationRecordSchema,
  runtimeOperationIntentSchema,
  surfaceRefSchema,
  windowRefSchema,
  z,
  type AdapterResult,
  type NativeExecutionContext,
  type OperationRecord,
  type TargetPrecondition,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { DesktopInputAdapter } from "@meta/input/adapter"
import {
  clickActionSchema,
  dragActionSchema,
  hoverActionSchema,
  inputActionResultSchema,
  keyActionSchema,
  scrollActionSchema,
  shortcutActionSchema,
  textActionSchema,
  type InputAction,
  type InputActionResult,
} from "@meta/input/actions"
import type { RuntimeCore } from "./core.ts"
import type { MethodDefinition, MethodRegistry } from "./method-registry.ts"

const pointerTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
  z.strictObject({ kind: z.literal("display"), ref: displayRefSchema }),
  z.strictObject({ kind: z.literal("desktop-layout"), ref: desktopLayoutRefSchema }),
])

const keyboardTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window"), ref: windowRefSchema }),
  z.strictObject({ kind: z.literal("surface"), ref: surfaceRefSchema }),
])

export const pointerInputPreconditionSchema = z.strictObject({
  target: pointerTargetSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  observationRef: observationRefSchema,
})

export const keyboardInputPreconditionSchema = z.strictObject({
  target: keyboardTargetSchema,
  inventoryId: opaqueIdSchema,
  inventoryRevision: z.number().int().safe().min(0),
  observationRef: observationRefSchema.optional(),
})

const pointerRequestShape = {
  clientRequestId: opaqueIdSchema,
  precondition: pointerInputPreconditionSchema,
}
const keyboardRequestShape = {
  clientRequestId: opaqueIdSchema,
  precondition: keyboardInputPreconditionSchema,
}

export const mouseMoveMethodInputSchema = z.strictObject({
  ...pointerRequestShape,
  action: hoverActionSchema,
})
export const mouseClickMethodInputSchema = z.strictObject({
  ...pointerRequestShape,
  action: clickActionSchema,
})
export const mouseScrollMethodInputSchema = z.strictObject({
  ...pointerRequestShape,
  action: scrollActionSchema,
})
export const mouseDragMethodInputSchema = z.strictObject({
  ...pointerRequestShape,
  action: dragActionSchema,
})
export const keyboardTypeMethodInputSchema = z.strictObject({
  ...keyboardRequestShape,
  action: textActionSchema,
})
export const keyboardKeyMethodInputSchema = z.strictObject({
  ...keyboardRequestShape,
  action: keyActionSchema,
})
export const keyboardShortcutMethodInputSchema = z.strictObject({
  ...keyboardRequestShape,
  action: shortcutActionSchema,
})

type InputMethodRequest = {
  clientRequestId: string
  precondition: TargetPrecondition
  action: InputAction
}

export type InputMethodOutput = {
  operation: OperationRecord
  result: AdapterResult<InputActionResult>
}

export const INPUT_METHOD_GAPS = Object.freeze({
  input_readiness: "Требуется Native readiness probe и Runtime-owned passive/active state",
  begin_interaction: "Требуется Runtime-owned bounded focus session и user-interference observer",
  end_interaction: "Требуется conditional restore через ту же Runtime interaction authority",
})

export const INPUT_METHOD_BUDGETS = Object.freeze({
  short: Object.freeze({ actionMs: 5_000, operationMs: 8_000, methodMs: 10_000 }),
  typing: Object.freeze({ actionMs: 30_000, operationMs: 33_000, methodMs: 35_000 }),
})

export type RegisterInputMethodsOptions = Readonly<{
  now?: () => Date
}>

export function registerInputMethods(
  registry: MethodRegistry,
  core: RuntimeCore,
  input: DesktopInputAdapter,
  options: RegisterInputMethodsOptions = {},
): void {
  const now = options.now ?? (() => new Date())
  registerAction(registry, core, input, {
    name: "mouse_move",
    title: "Навести указатель",
    description: "Адресованный hover по свежему observation и подтверждённой точке.",
    input: mouseMoveMethodInputSchema,
    capability: "input.pointer",
    resultKind: "hover",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "mouse_click",
    title: "Нажать указателем",
    description: "Адресованный click по свежему observation без автоматического replay.",
    input: mouseClickMethodInputSchema,
    capability: "input.pointer",
    resultKind: "click",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "mouse_scroll",
    title: "Прокрутить от точки",
    description: "Прокрутка с явным anchor из подтверждённого observation.",
    input: mouseScrollMethodInputSchema,
    capability: "input.pointer",
    resultKind: "scroll",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "mouse_drag",
    title: "Перетащить по траектории",
    description: "Адресованный drag с проверенной траекторией, duration и modifiers.",
    input: mouseDragMethodInputSchema,
    capability: "input.drag",
    resultKind: "drag",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "keyboard_type",
    title: "Ввести текст",
    description: "Unicode-ввод по grapheme clusters в адресованный native target.",
    input: keyboardTypeMethodInputSchema,
    capability: "input.keyboard",
    resultKind: "text",
    operationMs: INPUT_METHOD_BUDGETS.typing.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.typing.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "keyboard_key",
    title: "Нажать клавишу",
    description: "Адресованное нажатие клавиши с modifiers и native checkpoints.",
    input: keyboardKeyMethodInputSchema,
    capability: "input.keyboard",
    resultKind: "key",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
  registerAction(registry, core, input, {
    name: "keyboard_shortcut",
    title: "Выполнить сочетание клавиш",
    description: "Проверенная последовательность shortcut без частичного parsing во время dispatch.",
    input: keyboardShortcutMethodInputSchema,
    capability: "input.keyboard",
    resultKind: "shortcut",
    operationMs: INPUT_METHOD_BUDGETS.short.operationMs,
    methodMs: INPUT_METHOD_BUDGETS.short.methodMs,
    now,
  })
}

function registerAction(
  registry: MethodRegistry,
  core: RuntimeCore,
  input: DesktopInputAdapter,
  definition: {
    name: string
    title: string
    description: string
    input: z.ZodType<InputMethodRequest>
    capability: "input.pointer" | "input.drag" | "input.keyboard"
    resultKind: InputAction["kind"]
    operationMs: number
    methodMs: number
    now: () => Date
  },
): void {
  const resultSchema = inputActionResultSchema.extend({ kind: z.literal(definition.resultKind) })
  const outputSchema = z.strictObject({
    operation: operationRecordSchema,
    result: adapterResultSchema(resultSchema),
  }) as z.ZodType<InputMethodOutput>
  const method: MethodDefinition<InputMethodRequest, InputMethodOutput> = {
    title: definition.title,
    description: definition.description,
    input: definition.input,
    output: outputSchema,
    readOnly: false,
    destructive: true,
    timeoutMs: definition.methodMs,
    requiredCapabilities: [definition.capability],
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
    async execute(context, request) {
      const deadlineAt = new Date(definition.now().getTime() + definition.operationMs).toISOString()
      const intent = runtimeOperationIntentSchema.parse({
        intent: "mutation",
        clientRequestId: request.clientRequestId,
        precondition: request.precondition,
        deadlineAt,
        requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
      })
      return await core.runOperation(
        context.session,
        intent,
        request.action,
        async (operationContext, action) => {
          if (operationContext.wire.kind !== "native") {
            throw new Error("Input action требует NativeExecutionContext")
          }
          return await input.execute(
            operationContext as RuntimeOperationContext<NativeExecutionContext>,
            action,
          )
        },
        context.signal,
      )
    },
    isError: output => !output.result.ok,
  }
  registry.register(definition.name, method)
}
