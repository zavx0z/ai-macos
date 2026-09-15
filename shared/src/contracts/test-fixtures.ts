import {
  adapterHostContextSchema,
  freezeAdapterHostContext,
} from "./adapters.ts"
import { capabilitySetSchema } from "./capabilities.ts"
import {
  browserExecutionContextSchema,
  nativeExecutionContextSchema,
  runtimeClientSessionSchema,
} from "./operations.ts"
import type { OperationTarget } from "./identities.ts"

export const runtimeEpoch = "runtime:1"
export const loginSessionId = "login:1"
export const nativeGeneration = "native:1"
export const now = "2026-09-15T10:00:00.000Z"
export const deadlineAt = "2026-09-15T10:00:05.000Z"

export const session = runtimeClientSessionSchema.parse({
  clientSessionId: "client:1",
  principalId: "principal:1",
  runtimeEpoch,
  loginSessionId,
  authenticationGeneration: "auth:1",
  authenticatedAt: "2026-09-15T09:59:00.000Z",
  expiresAt: "2026-09-15T11:00:00.000Z",
})

export const windowRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  applicationRef: "application:1",
  windowRef: "window:1",
}

export const displayRef = {
  runtimeEpoch,
  loginSessionId,
  nativeGeneration,
  displayRef: "display:1",
  displayLayoutRevision: 3,
}

export const browserInstanceRef = {
  runtimeEpoch,
  loginSessionId,
  browserInstanceRef: "browser:1",
  transportGeneration: "browser-transport:1",
}

export const browserTargetRef = {
  ...browserInstanceRef,
  targetId: "target:1",
  resourceRef: "browser-target:1",
}

export const deviceBrowserInstanceRef = {
  runtimeEpoch,
  loginSessionId,
  deviceRef: "device:1",
  serial: "SERIAL-1",
  transportGeneration: "adb:1",
  browserInstanceRef: "android-browser:1",
  browserTransportGeneration: "android-cdp:1",
}

export const deviceBrowserTargetRef = {
  ...deviceBrowserInstanceRef,
  targetId: "android-target:1",
  resourceRef: "android-browser-target:1",
}

export const adapterCapabilities = capabilitySetSchema.parse({
  schemaVersion: "1",
  scope: "adapter",
  producerRef: "adapter:test",
  capabilities: [{ id: "runtime.identity", state: "ready" }],
})

export const host = freezeAdapterHostContext({
  generation: { runtimeEpoch, loginSessionId },
  runtimeBuildId: "runtime-build:1",
  capabilities: adapterCapabilities,
})

export function proof(
  kind: "target-resolution" | "pixel-ownership" | "frame-freshness" | "effect-readback" | "cg-ax-correlation",
  subject: OperationTarget,
  overrides: Record<string, unknown> = {},
) {
  return {
    proofRef: `proof:${kind}`,
    authorityRef: "proof-authority:1",
    kind,
    subject,
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    issuedAt: "2026-09-15T09:59:59.000Z",
    expiresAt: "2026-09-15T10:01:00.000Z",
    ...overrides,
  }
}

export const readyPolicy = {
  policyId: "readiness:frame",
  requiredSteps: ["complete-frame", "ownership"],
  disabledSteps: [],
} as const

export const readyResult = {
  state: "ready",
  policy: readyPolicy,
  steps: [
    { state: "reached", name: "complete-frame", durationMs: 10 },
    { state: "reached", name: "ownership", durationMs: 1 },
  ],
  timedOut: false,
} as const

export function nativeContext() {
  return nativeExecutionContextSchema.parse({
    kind: "native",
    operationId: "operation:1",
    clientRequestId: "client-request:1",
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    runtimeEpoch,
    loginSessionId,
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    deadlineAt,
    target: { kind: "window", ref: windowRef },
    nativeGeneration,
    fence: { runtimeEpoch, loginSessionId, nativeGeneration, counter: 1 },
  })
}

export function browserContext() {
  return browserExecutionContextSchema.parse({
    kind: "browser",
    operationId: "operation:browser:1",
    clientRequestId: "client-request:browser:1",
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    runtimeEpoch,
    loginSessionId,
    inventoryId: "browser-inventory:1",
    inventoryRevision: 2,
    deadlineAt,
    target: { kind: "browser-target", ref: browserTargetRef },
  })
}

export function resourceHandle(kind: string, resourceRef: string, operationId = "operation:1") {
  return {
    kind,
    resourceRef,
    leaseId: `lease:${resourceRef}`,
    leaseGeneration: "lease-generation:1",
    operationId,
    clientSessionId: session.clientSessionId,
    principalId: session.principalId,
    runtimeEpoch,
    loginSessionId,
    expiresAt: "2026-09-15T10:01:00.000Z",
    state: "active",
  }
}
