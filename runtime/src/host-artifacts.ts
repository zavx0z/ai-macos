import { constants, type Stats } from "node:fs"
import { lstat, open, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { dirname } from "node:path"
import { assertHostLockLeaseActive, type HostLockLease } from "./host-lock.ts"

const ARTIFACT_MODE = 0o600
const MAX_CREDENTIAL_BYTES = 4096
const DEFAULT_CONNECT_TIMEOUT_MS = 250

export type HostArtifactCleanupOptions = {
  socketPath: string
  credentialPath: string
  connectTimeoutMs?: number
}

export type HostArtifactCleanupResult = {
  removed: Array<"credential" | "socket">
}

/** Удаляет только проверенные артефакты завершившегося runtime под действующим host lease. */
export async function reclaimStaleHostArtifacts(
  lease: HostLockLease,
  options: HostArtifactCleanupOptions,
): Promise<HostArtifactCleanupResult> {
  assertHostLockLeaseActive(lease, options.socketPath)
  if (dirname(options.socketPath) !== dirname(options.credentialPath)) {
    throw new Error("Socket и credential должны находиться в одном private directory")
  }
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("Проверка stale socket должна иметь timeout 1..5000 ms")
  }

  const socket = await inspectSocket(options.socketPath, timeoutMs)
  const credential = await inspectCredential(options.credentialPath)
  const removed: Array<"credential" | "socket"> = []
  if (credential !== undefined) {
    await assertSameInode(options.credentialPath, credential)
    assertHostLockLeaseActive(lease, options.socketPath)
    await unlink(options.credentialPath)
    removed.push("credential")
  }
  if (socket !== undefined) {
    await assertSameInode(options.socketPath, socket)
    assertHostLockLeaseActive(lease, options.socketPath)
    await unlink(options.socketPath)
    removed.push("socket")
  }
  return { removed }
}

async function inspectSocket(path: string, timeoutMs: number) {
  const info = await lstatIfPresent(path)
  if (info === undefined) return undefined
  assertOwnedArtifact(info, path)
  if (!info.isSocket()) throw new Error(`Runtime socket artifact имеет посторонний тип: ${path}`)
  try {
    await probeSocket(path, timeoutMs)
  } catch (error) {
    throw new Error(`Runtime socket активен или его состояние не подтверждено: ${path}`, { cause: error })
  }
  await assertSameInode(path, info)
  return info
}

async function inspectCredential(path: string) {
  const initial = await lstatIfPresent(path)
  if (initial === undefined) return undefined
  assertOwnedArtifact(initial, path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw new Error(`Runtime credential artifact имеет посторонний тип или ссылки: ${path}`)
  }
  if (initial.size < 1 || initial.size > MAX_CREDENTIAL_BYTES) {
    throw new Error(`Runtime credential artifact нарушает byte limit: ${path}`)
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    assertOwnedArtifact(opened, path)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error(`Runtime credential artifact изменился во время проверки: ${path}`)
    }
    const bytes = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
    if (bytesRead !== opened.size) throw new Error(`Runtime credential artifact прочитан не полностью: ${path}`)
    assertCredentialSchema(JSON.parse(bytes.toString("utf8")))
  } catch (error) {
    throw new Error(`Runtime credential artifact не прошёл проверку: ${path}`, { cause: error })
  } finally {
    await handle.close()
  }
  await assertSameInode(path, initial)
  return initial
}

function assertOwnedArtifact(info: Stats, path: string) {
  const uid = process.getuid?.()
  if (uid === undefined || info.uid !== uid) throw new Error(`Runtime artifact принадлежит другому пользователю: ${path}`)
  if ((info.mode & 0o777) !== ARTIFACT_MODE) throw new Error(`Runtime artifact имеет небезопасный режим доступа: ${path}`)
}

function assertCredentialSchema(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Credential должен быть object")
  const record = value as Record<string, unknown>
  const allowed = new Set(["protocolVersion", "runtimeEpoch", "loginSessionId", "principalId", "bootstrapToken", "adminToken"])
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error("Credential содержит неизвестные поля")
  assertString(record.protocolVersion, "protocolVersion", 1, 1)
  if (record.protocolVersion !== "1") throw new Error("Credential protocolVersion не поддерживается")
  assertString(record.runtimeEpoch, "runtimeEpoch", 1, 64)
  assertString(record.loginSessionId, "loginSessionId", 1, 64)
  assertString(record.principalId, "principalId", 1, 127)
  assertString(record.bootstrapToken, "bootstrapToken", 1, 256)
  if (record.adminToken !== undefined) assertString(record.adminToken, "adminToken", 1, 256)
}

function assertString(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`Credential ${name} имеет недопустимую длину`)
  }
}

async function assertSameInode(path: string, expected: Stats) {
  const current = await lstat(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Runtime artifact был заменён после проверки: ${path}`)
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function probeSocket(path: string, timeoutMs: number): Promise<"refused"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Runtime socket probe превысил ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error("Runtime socket принимает подключения"))
    })
    socket.once("error", error => {
      clearTimeout(timer)
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve("refused")
      else reject(error)
    })
  })
}
