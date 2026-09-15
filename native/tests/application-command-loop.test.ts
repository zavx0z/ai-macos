import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalRecoveryJson,
  type ApplicationRef,
  type NativeExecutionContext,
  type NativeRecoveryDescriptor,
  type NativeRecoveryGrant,
} from "@meta/shared/contracts"
import {
  NativeBrokerAdapter,
  NativeProcessTransport,
} from "../src/adapter.ts"
import {
  nativeApplicationLaunchRequestSchema,
  nativeApplicationLaunchResponseSchema,
  nativeApplicationQuitRequestSchema,
  nativeApplicationQuitResponseSchema,
  nativeApplicationResolveRequestSchema,
  nativeApplicationResolveResponseSchema,
} from "../src/applications-protocol.ts"

let directory = ""
let binary = ""
let bundlePath = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-application-command-loop."))
  binary = join(directory, "fixture")
  bundlePath = join(directory, "Fixture.app")
  await mkdir(join(bundlePath, "Contents"), { recursive: true })
  await writeFile(join(bundlePath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fixture</string></dict></plist>`)
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m",
    "broker_transport.m",
    "operation-receipts/meta_operation_receipts.m",
    "input_job.m",
    "input_executor.m",
    "input_bridge.c",
    "executor.c",
    "ledger.c",
    "application-bundles/meta_application_bundles.m",
    "applications/meta_application_controller.m",
    "applications/meta_application_launch_task.m",
    "application-command/meta_application_command.m",
    "recovery-domain/meta_recovery_domain.m",
  ].map(path => join(native, "src", path))
  const compile = Bun.spawn([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-fblocks",
    "-mmacosx-version-min=13.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(native, "include")}`,
    `-I${join(native, "src")}`,
    ...sources,
    join(import.meta.dir, "application-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "AppKit",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 40_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-1",
  loginSessionId: "login-1",
  nativeGeneration: "native-application-fixture",
}

const digest = (value: unknown) => new Bun.CryptoHasher("sha256")
  .update(canonicalRecoveryJson(value))
  .digest("hex")

function grant(
  wire: NativeExecutionContext,
  descriptor: NativeRecoveryDescriptor,
): NativeRecoveryGrant {
  return {
    policyVersion: "1",
    ...generation,
    operationId: wire.operationId,
    contextSha256: digest(wire),
    descriptor,
    descriptorSha256: digest(descriptor),
    journalRevision: 1,
    durable: true,
  }
}

function createAdapter(mode?: string) {
  const adapter = new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-application-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "application-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: "application-adapter",
    transport: new NativeProcessTransport(binary, [
      bundlePath,
      ...(mode === undefined ? [] : [mode]),
    ]),
    ledgerSink: {
      async persist() {
        throw new Error("Application fixture не создаёт held-input ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Application fixture не публикует evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
  adapter.configureRecoveryAuthority(async (wire, descriptor) =>
    grant(wire as NativeExecutionContext, descriptor))
  return adapter
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

async function setup(mode?: string) {
  const adapter = createAdapter(mode)
  const handshake = await adapter.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: "handshake-application",
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-application-fixture",
    expectedNativeBuildId: "application-fixture-build",
    capabilitySchemaVersion: "1",
    requiredRecoveryDomainVersion: "1",
  })
  expect(handshake.recoveryDomainVersion).toBe("1")
  const resolutionRequest = nativeApplicationResolveRequestSchema.parse({
    kind: "request",
    intent: "read",
    protocolVersion: "1",
    requestId: "resolve-application",
    ...generation,
    deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    method: "application.resolve",
    payload: { path: bundlePath, bundleId: "com.example.fixture" },
  })
  const resolution = await adapter.request(
    nativeApplicationResolveRequestSchema,
    resolutionRequest,
    nativeApplicationResolveResponseSchema,
    control(),
  )
  if (!resolution.ok) throw new Error(resolution.error.message)
  return { adapter, bundle: resolution.result.target.ref }
}

function launchRequest(
  bundle: Awaited<ReturnType<typeof setup>>["bundle"],
  requestId: string,
  fenceCounter = 1,
) {
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  return nativeApplicationLaunchRequestSchema.parse({
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId,
    ...generation,
    deadlineAt,
    method: "application.launch",
    operation: {
      kind: "native",
      operationId: `operation-${requestId}`,
      clientRequestId: `client-${requestId}`,
      clientSessionId: "client-1",
      principalId: "principal-1",
      ...generation,
      deadlineAt,
      inventoryId: "inventory-1",
      inventoryRevision: 7,
      fence: { ...generation, counter: fenceCounter },
      target: { kind: "application-bundle", ref: bundle },
    },
    payload: { bundle, activate: true, newInstance: false },
  })
}

async function launch(
  adapter: NativeBrokerAdapter,
  request: ReturnType<typeof launchRequest>,
) {
  return await adapter.request(
    nativeApplicationLaunchRequestSchema,
    request,
    nativeApplicationLaunchResponseSchema,
    control(),
  )
}

function quitRequest(
  application: ApplicationRef,
  requestId: string,
  fenceCounter: number,
) {
  const deadlineAt = new Date(Date.now() + 3_000).toISOString()
  return nativeApplicationQuitRequestSchema.parse({
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId,
    ...generation,
    deadlineAt,
    method: "application.quit",
    operation: {
      kind: "native",
      operationId: `operation-${requestId}`,
      clientRequestId: `client-${requestId}`,
      clientSessionId: "client-1",
      principalId: "principal-1",
      ...generation,
      deadlineAt,
      inventoryId: "inventory-1",
      inventoryRevision: 7,
      fence: { ...generation, counter: fenceCounter },
      target: { kind: "application", ref: application },
    },
    payload: { application },
  })
}

async function quit(
  adapter: NativeBrokerAdapter,
  request: ReturnType<typeof quitRequest>,
) {
  return await adapter.request(
    nativeApplicationQuitRequestSchema,
    request,
    nativeApplicationQuitResponseSchema,
    control(),
  )
}

test("delayed launch drains, maps exact process and performs explicit activation", async () => {
  const { adapter, bundle } = await setup()
  try {
    const response = await launch(adapter, launchRequest(bundle, "launch-success"))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      value: {
        state: "running",
        application: { applicationRef: "application-1", pid: 501 },
      },
      status: {
        execution: "finished",
        dispatch: "finished",
        dispatchAttempts: 2,
        cleanup: "complete",
      },
    })
  } finally {
    await adapter.close()
  }
})

test("successful quit confirms exact process absence", async () => {
  const { adapter, bundle } = await setup()
  try {
    const launched = await launch(adapter, launchRequest(bundle, "launch-before-quit"))
    if (!launched.ok || launched.result.value.state !== "running")
      throw new Error("Fixture launch failed")
    const application = launched.result.value.application
    const response = await quit(
      adapter,
      quitRequest(application, "quit-success", 2),
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result).toMatchObject({
      value: { state: "terminated", application },
      status: { execution: "finished", dispatchAttempts: 1, cleanup: "complete" },
    })
  } finally {
    await adapter.close()
  }
})

test("quit lookup failure remains typed unknown with candidate identity", async () => {
  const { adapter, bundle } = await setup("--quit-unknown")
  try {
    const launched = await launch(adapter, launchRequest(bundle, "launch-before-unknown-quit"))
    if (!launched.ok || launched.result.value.state !== "running")
      throw new Error("Fixture launch failed")
    const application = launched.result.value.application
    const response = await quit(
      adapter,
      quitRequest(application, "quit-unknown", 2),
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.value).toMatchObject({
      state: "unknown",
      application,
      errors: [{ code: "operation-outcome-unknown" }],
    })
    expect(response.result.value).not.toHaveProperty("attentionMayBeRequired")
  } finally {
    await adapter.close()
  }
})

test("launch deadline returns typed unknown rather than false running", async () => {
  const { adapter, bundle } = await setup("--deadline")
  try {
    const response = await launch(adapter, launchRequest(bundle, "launch-deadline"))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.value).toMatchObject({
      state: "unknown",
      errors: [{ code: "operation-outcome-unknown" }],
    })
    expect(response.result.value).not.toHaveProperty("reused")
    expect(response.result.status.execution).not.toBe("finished")
  } finally {
    await adapter.close()
  }
})

test("explicit cancel preserves unknown launch and cancelled native status", async () => {
  const { adapter, bundle } = await setup("--cancel")
  try {
    const request = launchRequest(bundle, "launch-cancel")
    const pending = launch(adapter, request)
    await Bun.sleep(10)
    const cancelled = await adapter.cancel({
      requestId: "cancel-launch",
      ...generation,
      deadlineAt: new Date(Date.now() + 2_000).toISOString(),
      operationId: request.operation.operationId,
      fence: request.operation.fence,
      reason: "Injected cancellation",
    }, control())
    expect(cancelled.acknowledged).toBe(true)
    const response = await pending
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.value).toMatchObject({ state: "unknown" })
    expect(response.result.status).toMatchObject({
      execution: "cancelled",
      cleanup: "complete",
    })
  } finally {
    await adapter.close()
  }
})
