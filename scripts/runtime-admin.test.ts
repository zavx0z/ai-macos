import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  createRuntimeAdmin,
  type RuntimeAdminClient,
  type RuntimeAdminClientFactory,
} from "./runtime-admin.ts"

const inspection = {
  running: true as const,
  runtimeEpoch: "runtime:admin-adapter",
  runtimeBuildId: "runtime-build:admin-adapter",
  nativeBuildId: "native-build:admin-adapter",
  activeOperations: 2,
  quarantinedResources: 1,
}

test("inspect читает exact credential paths и отображает runtime/native identity", async () => {
  const calls: Array<{ socket: string, credential: string, timeoutMs: number }> = []
  const client: RuntimeAdminClient = {
    async adminInspect() { return inspection },
    async adminDrain(): Promise<never> { throw new Error("not used") },
  }
  const runRoot = "/tmp/meta-runtime-admin"
  const admin = createRuntimeAdmin({
    runRoot,
    timeoutMs: 1_250,
    clientFactory: async (socket, credential, options) => {
      calls.push({ socket, credential, timeoutMs: options.timeoutMs })
      return client
    },
  })
  expect(await admin.inspect()).toEqual(inspection)
  expect(await admin.inspect()).toEqual(inspection)
  expect(calls).toEqual([{
    socket: join(runRoot, "runtime.sock"),
    credential: join(runRoot, "credential.json"),
    timeoutMs: 1_250,
  }])
})

test("drain передаёт buildId mapping, bounded signal и принимает только exact complete receipt", async () => {
  let received: unknown
  let receivedSignal: AbortSignal | undefined
  const admin = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-drain",
    timeoutMs: 500,
    clientFactory: factory({
      async adminInspect() { return inspection },
      async adminDrain(expected, signal) {
        received = expected
        receivedSignal = signal
        return {
          runtimeEpoch: inspection.runtimeEpoch,
          runtimeBuildId: inspection.runtimeBuildId,
          nativeBuildId: inspection.nativeBuildId,
          cleanup: "complete",
          activeOperations: 0,
          quarantinedResources: 0,
        }
      },
    }),
  })
  const current = await admin.inspect()
  expect(await admin.drain(current)).toEqual({
    runtimeEpoch: inspection.runtimeEpoch,
    runtimeBuildId: inspection.runtimeBuildId,
    nativeBuildId: inspection.nativeBuildId,
    cleanup: "complete",
    activeOperations: 0,
    quarantinedResources: 0,
  })
  expect(received).toEqual({
    runtimeEpoch: inspection.runtimeEpoch,
    buildId: inspection.runtimeBuildId,
    nativeBuildId: inspection.nativeBuildId,
  })
  expect(receivedSignal?.aborted).toBe(false)
})

test("loaded runtime unavailable и отсутствующий native build остаются fail-closed", async () => {
  const unavailable = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-unavailable",
    clientFactory: async () => { throw new Error("credential/socket unavailable") },
  })
  await expect(unavailable.inspect()).rejects.toThrow("credential/socket unavailable")
  const missingNative = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-missing-native",
    clientFactory: factory({
      async adminInspect() {
        const { nativeBuildId: _, ...value } = inspection
        return value
      },
      async adminDrain(): Promise<never> { throw new Error("not used") },
    }),
  })
  await expect(missingNative.inspect()).rejects.toThrow("runtime/native builds")
})

test("foreign drain receipt и stale expected inspection отклоняются", async () => {
  const client: RuntimeAdminClient = {
    async adminInspect() { return inspection },
    async adminDrain() {
      return {
        runtimeEpoch: "runtime:foreign",
        runtimeBuildId: inspection.runtimeBuildId,
        nativeBuildId: inspection.nativeBuildId,
        cleanup: "complete",
        activeOperations: 0,
        quarantinedResources: 0,
      }
    },
  }
  const admin = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-foreign",
    clientFactory: factory(client),
  })
  await expect(admin.drain(inspection)).rejects.toThrow("foreign/incomplete")
  await expect(admin.drain({
    running: false,
    activeOperations: 0,
    quarantinedResources: 0,
  })).rejects.toThrow("exact running inspection")
})

test("caller abort и path/timeout bounds проверяются без client call", async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort(new Error("installer cancelled"))
  const admin = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-abort",
    signal: controller.signal,
    clientFactory: async () => { calls++; throw new Error("must not connect") },
  })
  await expect(admin.inspect()).rejects.toThrow("installer cancelled")
  expect(calls).toBe(0)
  const pendingController = new AbortController()
  const pending = createRuntimeAdmin({
    runRoot: "/tmp/meta-runtime-admin-pending",
    timeoutMs: 1_000,
    signal: pendingController.signal,
    clientFactory: factory({
      async adminInspect() { return await new Promise(() => {}) },
      async adminDrain(): Promise<never> { throw new Error("not used") },
    }),
  }).inspect()
  pendingController.abort(new Error("cancel pending inspect"))
  await expect(pending).rejects.toThrow("cancel pending inspect")
  expect(() => createRuntimeAdmin({
    runRoot: "/tmp/root",
    socketPath: "/tmp/foreign/runtime.sock",
  })).toThrow("exact children")
  expect(() => createRuntimeAdmin({ runRoot: "relative/run" })).toThrow("абсолютными")
  expect(() => createRuntimeAdmin({
    runRoot: `/tmp/${"x".repeat(120)}`,
  })).toThrow("sockaddr_un")
  expect(() => createRuntimeAdmin({ runRoot: "/tmp/root", timeoutMs: 99 })).toThrow("100..30000")
})

function factory(client: RuntimeAdminClient): RuntimeAdminClientFactory {
  return async () => client
}
