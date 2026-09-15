import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"

let directory = ""
let binary = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-permissions-loop."))
  binary = join(directory, "fixture")
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m", "broker_transport.m", "input_job.m", "ledger.c",
    "operation-receipts/meta_operation_receipts.m", "permissions-request/meta_permissions_request.m",
  ].map(path => join(native, "src", path))
  const compile = Bun.spawn([
    "/usr/bin/clang", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=13.0", "-Wall", "-Wextra", "-Werror",
    `-I${join(native, "include")}`, `-I${join(native, "src")}`, ...sources,
    join(import.meta.dir, "permissions-request-command-loop_fixture.m"),
    "-framework", "Foundation", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-o", binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
}, 30_000)
afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true }) })

test("startup permission prompts идут в private queue, heartbeat жив и prompts не повторяются", async () => {
  const reportPath = join(directory, "calls.json")
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "fixture", capabilities: [] } },
    adapterInstanceRef: "permissions-adapter", transport: new NativeProcessTransport(binary, [reportPath]),
    ledgerSink: { async persist() { throw new Error("Ledger не ожидается") } },
    bindEvidence: () => ({ publisher: { async publish() { throw new Error("Evidence не ожидается") } }, sourceResponses: { register() {} } }),
  })
  const control = { signal: AbortSignal.timeout(10_000), checkpoint() {} }
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "handshake",
      runtimeEpoch: "runtime", loginSessionId: "login", runtimeBuildId: "runtime-build",
      expectedNativeBuildId: "permissions-fixture-build", capabilitySchemaVersion: "1" }, control.signal)
    const generation = adapter.generation!
    const request = (command: "request-missing" | "status", requestId: string) => ({
      kind: "permissions-request" as const, protocolVersion: "1" as const, command, requestId, ...generation,
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    })
    const startedAt = performance.now()
    const started = await adapter.startupPermissionsRequest(request("request-missing", "permissions-start"), control)
    expect(performance.now() - startedAt).toBeLessThan(250)
    expect(started.requestsFinished).toBe(false)
    expect(started.permissions.accessibility.requestState).toBe("not-needed")
    expect(["queued", "requesting"]).toContain(started.permissions.screenRecording.requestState)
    const heartbeatAt = performance.now()
    const heartbeat = await adapter.heartbeat({ requestId: "permissions-heartbeat", ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, control)
    expect(heartbeat.accepted).toBe(true)
    expect(performance.now() - heartbeatAt).toBeLessThan(250)
    let status = started
    for (let index = 0; index < 40 && !status.requestsFinished; index += 1) {
      await Bun.sleep(50)
      status = await adapter.startupPermissionsRequest(request("status", `permissions-status-${index}`), control)
    }
    expect(status.requestsFinished).toBe(true)
    expect(status.allGranted).toBe(true)
    expect(status.restartState).toBe("not-required")
    expect(status.capabilities.producerRef).toBe(generation.nativeGeneration)
    await adapter.startupPermissionsRequest(request("request-missing", "permissions-repeat"), control)
    await Bun.sleep(350)
    const passive = await adapter.permissions({ kind: "permissions", protocolVersion: "1", requestId: "permissions-passive",
      ...generation, deadlineAt: new Date(Date.now() + 1000).toISOString() }, control)
    expect(passive).toMatchObject({ accessibility: true, screenRecording: true, postEvents: true, inputMonitoring: true })
    const drained = await adapter.drain({ requestId: "drain", ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, control)
    expect(drained.cleanup).toBe("complete")
  } finally {
    await adapter.close()
  }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    accessibility: 0,
    screenRecording: 1,
    postEvents: 1,
    inputMonitoring: 1,
  })
}, 30_000)

test("drain отменяет queued prompts, ждёт in-flight SDK и запрещает новый request-missing", async () => {
  const reportPath = join(directory, "drain-calls.json")
  const adapter = new NativeBrokerAdapter({
    host: { generation: { runtimeEpoch: "runtime", loginSessionId: "login" }, runtimeBuildId: "runtime-build",
      capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "fixture", capabilities: [] } },
    adapterInstanceRef: "permissions-drain-adapter", transport: new NativeProcessTransport(binary, [reportPath]),
    ledgerSink: { async persist() { throw new Error("Ledger не ожидается") } },
    bindEvidence: () => ({ publisher: { async publish() { throw new Error("Evidence не ожидается") } }, sourceResponses: { register() {} } }),
  })
  const control = { signal: AbortSignal.timeout(10_000), checkpoint() {} }
  try {
    await adapter.handshake({ kind: "handshake", protocolVersion: "1", requestId: "drain-handshake",
      runtimeEpoch: "runtime", loginSessionId: "login", runtimeBuildId: "runtime-build",
      expectedNativeBuildId: "permissions-fixture-build", capabilitySchemaVersion: "1" }, control.signal)
    const generation = adapter.generation!
    const request = (command: "request-missing" | "status", requestId: string) => ({
      kind: "permissions-request" as const, protocolVersion: "1" as const, command, requestId, ...generation,
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    })
    let status = await adapter.startupPermissionsRequest(request("request-missing", "drain-start"), control)
    for (let index = 0; index < 10 && status.permissions.screenRecording.requestState !== "requesting"; index += 1) {
      await Bun.sleep(10)
      status = await adapter.startupPermissionsRequest(request("status", `drain-prestatus-${index}`), control)
    }
    expect(status.permissions.screenRecording.requestState).toBe("requesting")
    adapter.sealForRotation()
    const firstDrain = await adapter.drain({ requestId: "drain-first", ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, control)
    expect(firstDrain).toMatchObject({ cleanup: "unknown", quarantined: true })
    await expect(adapter.startupPermissionsRequest(request("request-missing", "drain-forbidden"), control)).rejects.toThrow("draining")
    for (let index = 0; index < 20 && !status.requestsFinished; index += 1) {
      await Bun.sleep(30)
      status = await adapter.startupPermissionsRequest(request("status", `drain-status-${index}`), control)
    }
    expect(status.requestsFinished).toBe(true)
    expect(status.permissions.screenRecording.requestState).toBe("finished")
    expect(status.permissions.postEvents.requestState).toBe("cancelled")
    expect(status.permissions.inputMonitoring.requestState).toBe("cancelled")
    const finalDrain = await adapter.drain({ requestId: "drain-final", ...generation,
      deadlineAt: new Date(Date.now() + 1000).toISOString() }, control)
    expect(finalDrain).toMatchObject({ cleanup: "complete", quarantined: false })
  } finally {
    await adapter.close()
  }
  expect(JSON.parse((await readFile(reportPath)).toString())).toEqual({
    accessibility: 0,
    screenRecording: 1,
    postEvents: 0,
    inputMonitoring: 0,
  })
}, 30_000)
