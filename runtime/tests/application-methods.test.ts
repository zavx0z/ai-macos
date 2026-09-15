import { expect, test } from "bun:test"
import {
  CAPABILITY_IDS,
  capabilitySetSchema,
  type AdapterResult,
  type ApplicationBundleResolution,
  type ApplicationLaunchRequest,
  type ApplicationLaunchResult,
  type ApplicationQuitRequest,
  type ApplicationQuitResult,
  type ApplicationResolveRequest,
  type NativeAdapter,
  type NativeExecutionContext,
  type NativeOperationStatus,
  type OperationOutcome,
  type RuntimeOperationContext,
} from "@meta/shared/contracts"
import { registerApplicationMethods, type RuntimeApplicationAdapter } from "../src/application-methods.ts"
import { RuntimeCore } from "../src/core.ts"
import { MethodRegistry } from "../src/method-registry.ts"

const runtimeGeneration = {
  runtimeEpoch: "runtime:application-methods",
  loginSessionId: "login:application-methods",
}
const nativeGeneration = "native:application-methods"
const generation = { ...runtimeGeneration, nativeGeneration }
const observedAt = new Date().toISOString()
const requestedPath = "/Applications/Fixture Alias.app/"
const bundle = {
  ...generation,
  bundleRef: "bundle:application-methods",
  bundleId: "dev.meta.fixture",
  path: "/Applications/Fixture.app",
  device: "16777234",
  inode: "5001",
  modifiedAtNs: "1700000000000000000",
}
const application = {
  ...generation,
  applicationRef: "application:methods",
  pid: 4321,
  launchedAt: observedAt,
  registrationNonce: "process:application-methods",
}

test("catalogue публикует resolve и lifecycle с точными annotations", () => {
  const value = fixture()
  value.core.updateCapabilities(readyCapabilities())
  const tools = value.registry.descriptors().tools
  expect(tools.map(tool => tool.name)).toEqual(["resolve_application", "launch_application", "quit_application"])
  expect(tools.map(tool => tool.annotations)).toMatchObject([
    { readOnlyHint: true, destructiveHint: false },
    { readOnlyHint: false, destructiveHint: true },
    { readOnlyHint: false, destructiveHint: true },
  ])
})

test("running application inventory без lifecycle capability не рекламирует resolver", () => {
  const value = fixture()
  const capabilities = readyCapabilities()
  value.core.updateCapabilities({
    ...capabilities,
    capabilities: capabilities.capabilities.map(capability => capability.id === "desktop.application.lifecycle"
      ? { id: capability.id, state: "unavailable", reason: "Bundle handler не подключён" }
      : capability),
  })
  expect(value.registry.descriptors().tools).toEqual([])
})

test("resolve возвращает native-issued bundle без mutation operation", async () => {
  const value = fixture()
  value.core.updateCapabilities(readyCapabilities())
  const session = value.core.openClient("principal:resolve").session
  const response = await value.registry.dispatch(
    session,
    "resolve_application",
    { path: requestedPath, bundleId: bundle.bundleId },
    new AbortController().signal,
  )
  expect(response.data).toEqual(resolution())
  expect(value.resolveCalls()).toBe(1)
  expect(value.launchCalls()).toBe(0)
})

test("launch проходит Runtime authority, выдаёт desktop resource и не повторяется", async () => {
  const value = fixture()
  value.core.updateCapabilities(readyCapabilities())
  const session = value.core.openClient("principal:launch").session
  const input = {
    inventoryId: "inventory:bundle",
    inventoryRevision: 1,
    clientRequestId: "request:launch",
    request: { bundle, activate: true, newInstance: false },
  }
  const first = await value.registry.dispatch(session, "launch_application", input, new AbortController().signal)
  const repeated = await value.registry.dispatch(session, "launch_application", input, new AbortController().signal)
  expect(first.data).toMatchObject({
    operation: { state: "completed", context: { target: { kind: "application-bundle", ref: bundle } } },
    result: { ok: true, value: { state: "running", application, reused: false } },
  })
  expect(first.isError).toBe(false)
  expect(repeated.data).toEqual(first.data)
  expect(value.launchCalls()).toBe(1)
  expect(value.resources()).toMatchObject([{ kind: "desktop-input", resourceRef: "desktop", principalId: "principal:launch" }])
})

test("quit still-running завершает запрос, но возвращается как meaningful error", async () => {
  const value = fixture()
  value.core.updateCapabilities(readyCapabilities())
  const session = value.core.openClient("principal:quit").session
  const response = await value.registry.dispatch(session, "quit_application", {
    inventoryId: "inventory:application",
    inventoryRevision: 2,
    clientRequestId: "request:quit",
    request: { application },
  }, new AbortController().signal)
  expect(response.data).toMatchObject({
    operation: { state: "completed", context: { target: { kind: "application", ref: application } } },
    result: { ok: true, value: { state: "still-running", application, attentionMayBeRequired: true } },
  })
  expect(response.isError).toBe(true)
  expect(value.quitCalls()).toBe(1)
})

test("unknown launch остаётся failed с candidate context и quarantined resource", async () => {
  const value = fixture({ unknownLaunch: true })
  value.core.updateCapabilities(readyCapabilities())
  const session = value.core.openClient("principal:unknown-launch").session
  const response = await value.registry.dispatch(session, "launch_application", {
    inventoryId: "inventory:bundle",
    inventoryRevision: 1,
    clientRequestId: "request:unknown-launch",
    request: { bundle, activate: true, newInstance: false },
  }, new AbortController().signal)
  expect(response.data).toMatchObject({
    operation: { state: "failed", outcome: { cleanup: { state: "unknown" } } },
    result: {
      ok: false,
      error: {
        code: "operation-outcome-unknown",
        replayAllowed: false,
        context: { target: { kind: "application", ref: application } },
      },
      nativeStatus: { execution: "interrupted-unknown", cleanup: "unknown" },
    },
  })
  expect(response.isError).toBe(true)
  expect(value.launchCalls()).toBe(1)
})

test("launch schema не принимает caller-created process identity", async () => {
  const value = fixture()
  value.core.updateCapabilities(readyCapabilities())
  const session = value.core.openClient("principal:forged-process").session
  await expect(value.registry.dispatch(session, "launch_application", {
    inventoryId: "inventory:bundle",
    inventoryRevision: 1,
    clientRequestId: "request:forged-process",
    request: { bundle, activate: true, newInstance: false, application },
  }, new AbortController().signal)).rejects.toThrow()
  expect(value.launchCalls()).toBe(0)
})

function fixture(options: { unknownLaunch?: boolean } = {}) {
  let lastContext: RuntimeOperationContext<NativeExecutionContext> | undefined
  let lastStatus: NativeOperationStatus | undefined
  let resolveCalls = 0
  let launchCalls = 0
  let quitCalls = 0
  let resources: RuntimeOperationContext<NativeExecutionContext>["resources"] = []
  const native = {
    async status(request: { requestId: string }) {
      if (lastContext === undefined || lastStatus === undefined) throw new Error("Application operation не запускалась")
      return { ...lastStatus, requestId: request.requestId }
    },
  } as unknown as NativeAdapter
  const core = new RuntimeCore({
    generation: runtimeGeneration,
    runtimeBuildId: "runtime-build:application-methods",
    native,
    nativeGeneration,
  })
  core.targets.register(
    { kind: "application-bundle", ref: bundle },
    "inventory:bundle",
    1,
    "resolution:bundle",
    "proof:bundle",
    0,
  )
  core.targets.register(
    { kind: "application", ref: application },
    "inventory:application",
    2,
    "resolution:application",
    "proof:application",
    0,
  )
  const applications: RuntimeApplicationAdapter = {
    async resolve(request: ApplicationResolveRequest): Promise<ApplicationBundleResolution> {
      resolveCalls++
      expect(request).toEqual({ path: requestedPath, bundleId: bundle.bundleId })
      return resolution()
    },
    async launch(
      context: RuntimeOperationContext<NativeExecutionContext>,
      request: ApplicationLaunchRequest,
    ): Promise<AdapterResult<ApplicationLaunchResult>> {
      launchCalls++
      lastContext = context
      resources = context.resources
      expect(request.bundle).toEqual(bundle)
      if (options.unknownLaunch) {
        lastStatus = statusFor(context, "interrupted-unknown", "unknown")
        return {
          ok: false,
          error: {
            code: "operation-outcome-unknown",
            message: "Launch result неизвестен",
            stage: "application-launch",
            retryable: false,
            replayAllowed: false,
            recoveryAction: "get-operation",
            context: { operationId: context.wire.operationId, target: { kind: "application", ref: application } },
          },
          outcome: outcome(context, lastStatus),
          nativeStatus: lastStatus,
        }
      }
      lastStatus = statusFor(context, "finished", "complete")
      return {
        ok: true,
        value: { state: "running", application, reused: false },
        outcome: outcome(context, lastStatus),
        nativeStatus: lastStatus,
      }
    },
    async quit(
      context: RuntimeOperationContext<NativeExecutionContext>,
      request: ApplicationQuitRequest,
    ): Promise<AdapterResult<ApplicationQuitResult>> {
      quitCalls++
      lastContext = context
      resources = context.resources
      expect(request.application).toEqual(application)
      lastStatus = statusFor(context, "finished", "complete")
      return {
        ok: true,
        value: { state: "still-running", application, attentionMayBeRequired: true },
        outcome: outcome(context, lastStatus),
        nativeStatus: lastStatus,
      }
    },
  }
  const registry = new MethodRegistry(core)
  registerApplicationMethods(registry, core, applications)
  return {
    core,
    registry,
    resolveCalls: () => resolveCalls,
    launchCalls: () => launchCalls,
    quitCalls: () => quitCalls,
    resources: () => resources,
  }
}

function readyCapabilities() {
  return capabilitySetSchema.parse({
    schemaVersion: "1",
    scope: "runtime",
    producerRef: "runtime:application-methods",
    capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })),
  })
}

function resolution(): ApplicationBundleResolution {
  return {
    requestedPath,
    sourceResponseRef: "source:bundle",
    inventoryId: "inventory:bundle",
    inventoryRevision: 1,
    observedAt,
    target: { kind: "application-bundle", ref: bundle },
  }
}

function statusFor(
  context: RuntimeOperationContext<NativeExecutionContext>,
  execution: NativeOperationStatus["execution"],
  cleanup: NativeOperationStatus["cleanup"],
): NativeOperationStatus {
  return {
    requestId: `native-status:${context.wire.operationId}`,
    ...generation,
    highWaterFence: context.wire.fence,
    acceptedFence: context.wire.fence,
    operationId: context.wire.operationId,
    execution,
    dispatch: "finished",
    cleanup,
    targetVerified: "verified",
    cancellationRequested: false,
    userInterference: "unknown",
    restorationAllowed: false,
    quarantined: execution === "interrupted-unknown",
    heldCount: cleanup === "complete" ? 0 : 1,
    lastCheckpoint: "application-method-fixture",
    dispatchAttempts: 1,
    ledgerRevision: 1,
    observer: {
      state: "unavailable",
      ...generation,
      coverageStartCursor: "cursor:application-methods",
      cursor: "cursor:application-methods",
      nextSequence: 1,
      startedAt: observedAt,
      coveredFrom: observedAt,
      coveredThrough: observedAt,
      heartbeatAt: observedAt,
      coveredKinds: [],
      droppedEvents: 0,
      gapDetected: false,
      reason: "Observer fixture недоступен",
    },
  }
}

function outcome(
  context: RuntimeOperationContext<NativeExecutionContext>,
  status: NativeOperationStatus,
): OperationOutcome {
  const complete = status.cleanup === "complete"
  return {
    dispatch: status.dispatch,
    targetVerified: status.targetVerified,
    userInterference: status.userInterference,
    observation: "unavailable",
    effect: { state: "unverified", proofRefs: [] },
    cleanup: {
      scope: "owned",
      state: complete ? "complete" : "unknown",
      resources: context.resources.map(handle => ({ handle, outcome: complete ? "released" as const : "quarantined" as const })),
      ...(complete ? {} : { reason: "Native cleanup неизвестен" }),
    },
    restoration: "not-applicable",
    dispatchAttempts: status.dispatchAttempts,
    ledgerRevision: status.ledgerRevision,
  }
}
