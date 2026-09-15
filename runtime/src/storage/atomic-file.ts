import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

export type DurableWriteStage =
  | "before-write"
  | "after-write"
  | "after-file-sync"
  | "after-rename"
  | "after-directory-sync"

export type DurableWriteFailpoint = (
  stage: DurableWriteStage,
  targetPath: string,
) => void | Promise<void>

export type DurableWriteOptions = {
  failpoint?: DurableWriteFailpoint
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  await ensureDirectoryChain(absolute)
  const info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Storage path не является обычным каталогом: ${absolute}`)
  }
  await chmod(absolute, 0o700)
  await syncDirectory(dirname(absolute))
}

export async function syncFileAndParent(path: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path))
  const file = await open(path, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDirectory(dirname(path))
}

export async function atomicReplace(
  targetPath: string,
  bytes: Uint8Array,
  options: DurableWriteOptions = {},
): Promise<void> {
  const directory = dirname(targetPath)
  await ensurePrivateDirectory(directory)
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let temporaryCreated = false
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await options.failpoint?.("before-write", targetPath)
    handle = await open(temporaryPath, "wx", 0o600)
    temporaryCreated = true
    await handle.writeFile(bytes)
    await options.failpoint?.("after-write", targetPath)
    await handle.sync()
    await options.failpoint?.("after-file-sync", targetPath)
    await handle.close()
    handle = undefined
    await rename(temporaryPath, targetPath)
    temporaryCreated = false
    await options.failpoint?.("after-rename", targetPath)
    await syncDirectory(directory)
    await options.failpoint?.("after-directory-sync", targetPath)
  } finally {
    await handle?.close().catch(() => undefined)
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined)
  }
}

async function ensureDirectoryChain(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Storage ancestor не является обычным каталогом: ${path}`)
    }
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const parent = dirname(path)
  if (parent === path) throw new Error(`Не найден filesystem root для storage: ${path}`)
  await ensureDirectoryChain(parent)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Созданный storage path не является каталогом: ${path}`)
  }
  await chmod(path, 0o700)
  await syncDirectory(parent)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
