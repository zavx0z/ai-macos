import { dlopen, FFIType } from "bun:ffi"

const LOCK_EXCLUSIVE = 0x02
const LOCK_NONBLOCKING = 0x04
const LOCK_UNLOCK = 0x08
const F_SET_DESCRIPTOR_FLAGS = 2
const FILE_DESCRIPTOR_CLOSE_ON_EXEC = 1

function openSystem() { return dlopen("/usr/lib/libSystem.B.dylib", {
  fcntl: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
}) }
let system: ReturnType<typeof openSystem> | undefined

function lockLibrary() {
  // Импорт thin client не должен загружать macOS library до проверки машины.
  if (process.platform !== "darwin") throw new Error("Runtime host lock поддерживается только на macOS")
  return system ??= openSystem()
}

/** Запрещает наследовать lock fd запускаемому helper-процессу. */
export function makeFileDescriptorCloseOnExec(fd: number) {
  return lockLibrary().symbols.fcntl(fd, F_SET_DESCRIPTOR_FLAGS, FILE_DESCRIPTOR_CLOSE_ON_EXEC) === 0
}

/** Захватывает process-lifetime advisory lock без ожидания другого владельца. */
export function acquireExclusiveFileLock(fd: number) {
  return lockLibrary().symbols.flock(fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) === 0
}

/** Освобождает advisory lock; закрытие fd остаётся ответственностью вызывающего кода. */
export function releaseFileLock(fd: number) {
  lockLibrary().symbols.flock(fd, LOCK_UNLOCK)
}
