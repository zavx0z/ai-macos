import {
  DESKTOP_INPUT_RESOURCE_REF,
  authorizeAdapterContext,
  contractErrorSchema,
  requireAuthorizedResourceHandles,
  structurallyEqual,
  type AdapterHostContext,
  type AdapterServices,
  type AuthorizedObservationPoint,
  type ContractError,
  type ContractErrorCode,
  type NativeExecutionContext,
  type RuntimeOperationContext,
  type TargetResolution,
} from "@meta/shared/contracts"
import {
  InputPlanError,
  planActionBudget,
  planClick,
  planDrag,
  planHover,
  planKey,
  planScroll,
  planShortcuts,
  planText,
  remainingActionBudget,
  type ActionBudget,
} from "./action-plan.ts"
import {
  inputActionSchema,
  pointerActionPoints,
  type InputAction,
  type InputActionPlan,
  type KeyboardInputAction,
  type PointerInputAction,
} from "./actions.ts"

export class InputPreparationError extends Error {
  constructor(readonly contract: ContractError) {
    super(contract.message)
    this.name = "InputPreparationError"
  }
}

export type PreparedInputAction = Readonly<{
  action: InputAction
  plan: InputActionPlan
  target: TargetResolution
  authorizedPoints: readonly AuthorizedObservationPoint[]
}>

const pointerTargetKinds = new Set(["window", "surface", "display", "desktop-layout"])
const keyboardTargetKinds = new Set(["window", "surface"])

export async function prepareInputAction(
  host: AdapterHostContext,
  services: AdapterServices,
  context: RuntimeOperationContext<NativeExecutionContext>,
  input: InputAction,
  now: Date,
): Promise<PreparedInputAction> {
  let action: InputAction
  try {
    action = inputActionSchema.parse(input)
  } catch (error) {
    throwInput(error, "invalid-request", "input-parse")
  }
  try {
    await context.control.checkpoint("input.authorize-context")
    await authorizeAdapterContext(host, services, context, now)
  } catch (error) {
    throwInput(error, "unauthorized", "input-authority")
  }

  const capability = action.kind === "drag"
    ? "input.drag"
    : ["hover", "click", "scroll"].includes(action.kind)
      ? "input.pointer"
      : "input.keyboard"
  if (host.capabilities.capabilities.find(candidate => candidate.id === capability)?.state !== "ready") {
    throwInput(new Error(`Adapter capability ${capability} не готова`), "capability-unavailable", "input-capability")
  }

  try {
    await requireAuthorizedResourceHandles(
      services.resources,
      context.resources,
      {
        operationId: context.wire.operationId,
        clientSessionId: context.wire.clientSessionId,
        principalId: context.wire.principalId,
        runtimeEpoch: context.wire.runtimeEpoch,
        loginSessionId: context.wire.loginSessionId,
        now,
      },
      [{ kind: "desktop-input", resourceRef: DESKTOP_INPUT_RESOURCE_REF }],
    )
  } catch (error) {
    throwInput(error, "lease-revoked", "input-resource")
  }
  try {
    await context.control.checkpoint("input.resolve-target")
  } catch (error) {
    throwInput(error, "cancelled", "input-resolve-target")
  }
  let target: TargetResolution
  try {
    target = await services.targets.resolve({
      target: context.wire.target,
      inventoryId: context.wire.inventoryId,
      inventoryRevision: context.wire.inventoryRevision,
      runtimeEpoch: context.wire.runtimeEpoch,
      loginSessionId: context.wire.loginSessionId,
      nativeGeneration: context.wire.nativeGeneration,
      deadlineAt: context.wire.deadlineAt,
    })
  } catch (error) {
    throwInput(error, "target-stale", "input-target")
  }

  let plan: InputActionPlan
  try {
    plan = planInputAction(action)
  } catch (error) {
    const code = error instanceof InputPlanError && error.code === "budget-exceeded"
      ? inputBudgetErrorCode(error)
      : "invalid-request"
    throwInput(error, code, "input-plan")
  }
  assertTargetResolution(context, target)
  const authorizedPoints = isPointerAction(action)
    ? await authorizePointerAction(services, context, action, now)
    : authorizeKeyboardTarget(context, action)

  try {
    await context.control.checkpoint("input.ready-dispatch")
  } catch (error) {
    throwInput(error, "cancelled", "input-ready-dispatch")
  }
  return { action, plan, target, authorizedPoints }
}

export function admitPreparedInputBudget(
  prepared: PreparedInputAction,
  operationDeadlineAt: string,
  now: Date,
): ActionBudget {
  let budget: ActionBudget
  try {
    const kind = prepared.action.kind === "text"
      ? "typing"
      : ["hover", "click", "scroll", "drag"].includes(prepared.action.kind)
        ? "pointer"
        : "keyboard"
    budget = planActionBudget(kind, Date.parse(operationDeadlineAt), now.getTime())
  } catch (error) {
    throwInput(error, "deadline-exceeded", "input-budget-admission")
  }
  const knownDurationMs = knownPlanDurationMs(prepared.plan)
  if (knownDurationMs > remainingActionBudget(budget, now.getTime())) {
    throwInput(
      new Error(`Известная длительность ${knownDurationMs} мс не помещается в оставшийся physical action budget`),
      "deadline-exceeded",
      "input-budget-admission",
    )
  }
  return budget
}

function planInputAction(action: InputAction): InputActionPlan {
  switch (action.kind) {
    case "hover":
      return planHover(action.point)
    case "click":
      return planClick(action)
    case "scroll":
      return planScroll(action)
    case "drag":
      return planDrag(action)
    case "text":
      return planText(action)
    case "key":
      return planKey(action.key, action.modifiers)
    case "shortcut":
      return planShortcuts(action)
  }
}

function isPointerAction(action: InputAction): action is PointerInputAction {
  return ["hover", "click", "scroll", "drag"].includes(action.kind)
}

async function authorizePointerAction(
  services: AdapterServices,
  context: RuntimeOperationContext<NativeExecutionContext>,
  action: PointerInputAction,
  now: Date,
): Promise<readonly AuthorizedObservationPoint[]> {
  if (!pointerTargetKinds.has(context.wire.target.kind)) {
    throwInput(new Error(`Pointer action не поддерживает target ${context.wire.target.kind}`), "invalid-request", "input-target")
  }
  const observationRef = context.wire.observationRef
  if (observationRef === undefined) {
    throwInput(new Error("Pointer action требует observationRef"), "observation-stale", "input-observation")
  }

  const authorized: AuthorizedObservationPoint[] = []
  for (const [index, imagePoint] of pointerActionPoints(action).entries()) {
    try {
      await context.control.checkpoint(`input.authorize-point.${index}`)
    } catch (error) {
      throwInput(error, "cancelled", `input-authorize-point.${index}`)
    }
    try {
      const point = await services.observations.resolvePoint({
        operation: context.wire,
        observationRef,
        imagePoint,
        interactionTarget: context.wire.target,
        expectedSpace: "macos-screen",
      })
      assertAuthorizedPoint(context, observationRef.observationId, imagePoint, point, index)
      authorized.push(point)
    } catch (error) {
      throwInput(error, "proof-invalid", `input-point-proof.${index}`)
    }
  }
  return authorized
}

function authorizeKeyboardTarget(
  context: RuntimeOperationContext<NativeExecutionContext>,
  action: KeyboardInputAction,
): readonly AuthorizedObservationPoint[] {
  if (!keyboardTargetKinds.has(context.wire.target.kind)) {
    throwInput(new Error(`${action.kind} не поддерживает target ${context.wire.target.kind}`), "invalid-request", "input-target")
  }
  return []
}

function throwInput(error: unknown, fallbackCode: ContractErrorCode, stage: string): never {
  if (error instanceof InputPreparationError) throw error
  if (typeof error === "object" && error !== null && "contract" in error) {
    const parsed = contractErrorSchema.safeParse((error as { contract: unknown }).contract)
    if (parsed.success) throw new InputPreparationError(parsed.data)
  }
  const code = error instanceof DOMException && error.name === "AbortError" ? "cancelled" : fallbackCode
  throw new InputPreparationError(contractErrorSchema.parse({
    code,
    message: (error instanceof Error ? error.message : "Неизвестная ошибка подготовки input").slice(0, 2_048),
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: code === "observation-stale" || code === "proof-invalid"
      ? "capture-new-observation"
      : code === "target-stale"
        ? "refresh-inventory"
        : code === "lease-revoked" || code === "cancelled"
          ? "get-operation"
          : "none",
  }))
}

function inputBudgetErrorCode(error: InputPlanError): ContractErrorCode {
  return error.message.includes("UTF-16") || error.message.includes("точек")
    ? "payload-too-large"
    : "deadline-exceeded"
}

function knownPlanDurationMs(plan: InputActionPlan): number {
  switch (plan.kind) {
    case "drag":
      return plan.durationMs
    case "text":
      return plan.estimatedDurationMs
    case "shortcut":
      return plan.delayMs * Math.max(0, plan.steps.length - 1)
    case "hover":
    case "click":
    case "scroll":
    case "key":
      return 0
  }
}

function assertTargetResolution(
  context: RuntimeOperationContext<NativeExecutionContext>,
  target: TargetResolution,
): void {
  if (
    !structurallyEqual(target.target, context.wire.target)
    || target.inventoryId !== context.wire.inventoryId
    || target.inventoryRevision !== context.wire.inventoryRevision
    || target.nativeGeneration !== context.wire.nativeGeneration
    || (
      context.wire.observationRef !== undefined
      && target.displayLayoutRevision !== context.wire.observationRef.displayLayoutRevision
    )
  ) {
    throwInput(
      new Error("Target resolution не совпадает с operation target/generations/revisions"),
      "target-stale",
      "input-target-binding",
    )
  }
  if (target.proofRef.length === 0 || target.resolutionId.length === 0) {
    throwInput(new Error("Target resolution не содержит authority proof"), "proof-invalid", "input-target-binding")
  }
}

function assertAuthorizedPoint(
  context: RuntimeOperationContext<NativeExecutionContext>,
  observationId: string,
  imagePoint: { x: number, y: number },
  point: AuthorizedObservationPoint,
  index: number,
): void {
  if (
    point.authorized !== true
    || point.observationId !== observationId
    || !structurallyEqual(point.imagePoint, imagePoint)
    || !structurallyEqual(point.interactionTarget, context.wire.target)
    || point.space.kind !== "macos-screen"
    || point.space.display.runtimeEpoch !== context.wire.runtimeEpoch
    || point.space.display.loginSessionId !== context.wire.loginSessionId
    || point.space.display.nativeGeneration !== context.wire.nativeGeneration
    || point.space.display.displayLayoutRevision !== context.wire.observationRef?.displayLayoutRevision
    || !nativeTargetMatchesGeneration(point.captureTarget, context.wire)
    || !Number.isFinite(point.destinationPoint.x)
    || !Number.isFinite(point.destinationPoint.y)
    || point.ownershipProofRef.length === 0
  ) {
    throwInput(
      new Error(`Authorized point ${index} не связан с operation/observation/image point/generations`),
      "proof-invalid",
      `input-point-binding.${index}`,
    )
  }
}

function nativeTargetMatchesGeneration(
  target: AuthorizedObservationPoint["captureTarget"],
  operation: NativeExecutionContext,
): boolean {
  return ["application", "window", "surface", "element", "display", "desktop-layout"].includes(target.kind)
    && target.ref.runtimeEpoch === operation.runtimeEpoch
    && target.ref.loginSessionId === operation.loginSessionId
    && "nativeGeneration" in target.ref
    && target.ref.nativeGeneration === operation.nativeGeneration
}
