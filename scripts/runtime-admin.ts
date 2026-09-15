import { isAbsolute, join, resolve } from "node:path"
import {
  RuntimeUdsClient,
  type RuntimeAdminDrainReceipt as UdsDrainReceipt,
  type RuntimeAdminInspection as UdsInspection,
} from "../runtime/src/transport.ts"
import type {
  RuntimeAdmin,
  RuntimeDrainReceipt,
  RuntimeInspection,
} from "./runtime-install.ts"

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_UNIX_SOCKET_BYTES = 103

export interface RuntimeAdminClient {
  adminInspect(): Promise<UdsInspection>
  adminDrain(
    expected: { runtimeEpoch: string, buildId: string, nativeBuildId?: string },
    signal?: AbortSignal,
  ): Promise<UdsDrainReceipt>
}

export type RuntimeAdminClientFactory = (
  socketPath: string,
  credentialPath: string,
  options: { timeoutMs: number },
) => Promise<RuntimeAdminClient>

export type RuntimeAdminOptions = {
  runRoot: string
  socketPath?: string
  credentialPath?: string
  timeoutMs?: number
  signal?: AbortSignal
  clientFactory?: RuntimeAdminClientFactory
}

export function createRuntimeAdmin(options: RuntimeAdminOptions): RuntimeAdmin {
  if (!isAbsolute(options.runRoot)
    || options.socketPath !== undefined && !isAbsolute(options.socketPath)
    || options.credentialPath !== undefined && !isAbsolute(options.credentialPath)) {
    throw new Error("Runtime admin paths должны быть абсолютными")
  }
  const runRoot = resolve(options.runRoot)
  const socketPath = resolve(options.socketPath ?? join(runRoot, "runtime.sock"))
  const credentialPath = resolve(options.credentialPath ?? join(runRoot, "credential.json"))
  if (socketPath !== join(runRoot, "runtime.sock")
    || credentialPath !== join(runRoot, "credential.json")) {
    throw new Error("Runtime admin paths должны быть exact children одного runRoot")
  }
  if (new TextEncoder().encode(socketPath).byteLength > MAX_UNIX_SOCKET_BYTES) {
    throw new Error("Runtime admin UDS path превышает macOS sockaddr_un limit")
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("Runtime admin timeout должен быть 100..30000 ms")
  }
  const clientFactory = options.clientFactory ?? ((socket, credential, clientOptions) => {
    return RuntimeUdsClient.fromCredentialFile(socket, credential, clientOptions)
  })
  let clientPromise: Promise<RuntimeAdminClient> | undefined
  const client = () => {
    assertNotAborted(options.signal)
    clientPromise ??= clientFactory(socketPath, credentialPath, { timeoutMs })
    return clientPromise
  }

  return Object.freeze({
    async inspect(): Promise<RuntimeInspection> {
      assertNotAborted(options.signal)
      const signal = boundedSignal(options.signal, timeoutMs)
      const currentClient = await waitBounded(client(), signal)
      const current = await waitBounded(currentClient.adminInspect(), signal)
      assertNotAborted(options.signal)
      if (!current.running || current.nativeBuildId === undefined) {
        throw new Error("Loaded runtime admin inspection не подтверждает running runtime/native builds")
      }
      return {
        running: true,
        runtimeEpoch: current.runtimeEpoch,
        runtimeBuildId: current.runtimeBuildId,
        nativeBuildId: current.nativeBuildId,
        activeOperations: current.activeOperations,
        quarantinedResources: current.quarantinedResources,
      }
    },

    async drain(expected: RuntimeInspection): Promise<RuntimeDrainReceipt> {
      assertExpectedInspection(expected)
      const signal = boundedSignal(options.signal, timeoutMs)
      const currentClient = await waitBounded(client(), signal)
      const receipt = await currentClient.adminDrain({
        runtimeEpoch: expected.runtimeEpoch,
        buildId: expected.runtimeBuildId,
        nativeBuildId: expected.nativeBuildId,
      }, signal)
      if (receipt.runtimeEpoch !== expected.runtimeEpoch
        || receipt.runtimeBuildId !== expected.runtimeBuildId
        || receipt.nativeBuildId !== expected.nativeBuildId
        || receipt.cleanup !== "complete"
        || receipt.activeOperations !== 0
        || receipt.quarantinedResources !== 0) {
        throw new Error("Runtime admin drain вернул foreign/incomplete receipt")
      }
      return {
        runtimeEpoch: receipt.runtimeEpoch,
        runtimeBuildId: receipt.runtimeBuildId,
        nativeBuildId: receipt.nativeBuildId,
        cleanup: "complete",
        activeOperations: 0,
        quarantinedResources: 0,
      }
    },
  })
}

function assertExpectedInspection(
  expected: RuntimeInspection,
): asserts expected is RuntimeInspection & {
  running: true
  runtimeEpoch: string
  runtimeBuildId: string
  nativeBuildId: string
} {
  if (!expected.running || expected.runtimeEpoch === undefined
    || expected.runtimeBuildId === undefined || expected.nativeBuildId === undefined) {
    throw new Error("Runtime admin drain требует exact running inspection с runtime/native builds")
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Runtime admin отменён", "AbortError")
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

async function waitBounded<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) assertNotAborted(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Runtime admin отменён", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([promise, aborted]) }
  finally { if (onAbort !== undefined) signal.removeEventListener("abort", onAbort) }
}
