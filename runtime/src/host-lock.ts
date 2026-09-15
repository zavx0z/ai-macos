import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { acquireExclusiveFileLock, makeFileDescriptorCloseOnExec, releaseFileLock } from "./host-lock-native.ts"

const LOCK_MODE = 0o600
const PRIVATE_DIRECTORY_MODE_MASK = 0o077
const MAX_METADATA_BYTES = 1024

export type HostLockRelease = (() => Promise<void>) & { readonly lease: HostLockLease }

export type HostLockLease = Readonly<{
  socketPath: string
  lockPath: string
}>

const activeHostLockLeases = new WeakSet<HostLockLease>()

/** Проверяет, что lease выдан этим процессом, ещё активен и относится к exact socket. */
export function assertHostLockLeaseActive(lease: HostLockLease, socketPath: string) {
  if (!activeHostLockLeases.has(lease) || lease.socketPath !== socketPath) {
    throw new Error("Действующий runtime host lease для очистки артефактов отсутствует")
  }
}

export async function acquireHostLock(socketPath: string): Promise<HostLockRelease> {
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(directory)

  const legacyPath = `${socketPath}.owner`
  if (await pathExists(legacyPath)) {
    throw new Error(`Legacy runtime host lock требует подтверждённой остановки прежнего сервиса и отдельного восстановления: ${legacyPath}`)
  }

  const lockPath = `${socketPath}.lock`
  let handle
  try {
    handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, LOCK_MODE)
  } catch (error) {
    throw new Error(`Runtime host lock недоступен или не является обычным файлом: ${lockPath}`, { cause: error })
  }

  let locked = false
  try {
    const opened = await handle.stat()
    assertPrivateLockFile(opened, lockPath)
    if (!makeFileDescriptorCloseOnExec(handle.fd)) throw new Error(`Runtime host lock fd не удалось закрыть для exec: ${lockPath}`)
    if (!acquireExclusiveFileLock(handle.fd)) throw new Error(`Runtime host lock уже удерживается: ${lockPath}`)
    locked = true

    const current = await lstat(lockPath)
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`Runtime host lock был заменён во время захвата: ${lockPath}`)
    }
    assertPrivateLockFile(current, lockPath)

    const metadata = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      uid: current.uid,
      acquiredAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    }))
    if (metadata.byteLength > MAX_METADATA_BYTES) throw new Error("Runtime host lock metadata превышает допустимый размер")
    await handle.truncate(0)
    await handle.write(metadata, 0, metadata.byteLength, 0)
    await handle.sync()

    const lease: HostLockLease = Object.freeze({ socketPath, lockPath })
    activeHostLockLeases.add(lease)
    let released = false
    const release = async () => {
      if (released) return
      released = true
      activeHostLockLeases.delete(lease)
      releaseFileLock(handle.fd)
      await handle.close()
    }
    return Object.defineProperty(release, "lease", { value: lease }) as HostLockRelease
  } catch (error) {
    if (locked) releaseFileLock(handle.fd)
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertPrivateDirectory(path: string) {
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Runtime directory не является обычным каталогом: ${path}`)
  if (uid === undefined || info.uid !== uid) throw new Error(`Runtime directory принадлежит другому пользователю: ${path}`)
  if ((info.mode & PRIVATE_DIRECTORY_MODE_MASK) !== 0) throw new Error(`Runtime directory доступен другим пользователям: ${path}`)
}

function assertPrivateLockFile(info: Stats, path: string) {
  const uid = process.getuid?.()
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime host lock не является обычным файлом: ${path}`)
  if (uid === undefined || info.uid !== uid) throw new Error(`Runtime host lock принадлежит другому пользователю: ${path}`)
  if ((info.mode & 0o777) !== LOCK_MODE) throw new Error(`Runtime host lock имеет небезопасный режим доступа: ${path}`)
  if (info.nlink !== 1) throw new Error(`Runtime host lock имеет посторонние жёсткие ссылки: ${path}`)
}

async function pathExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
