import { expect, test } from "bun:test"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireHostLock } from "../src/host-lock.ts"

test("kernel lock блокирует второй процесс и освобождается после SIGKILL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-lock-crash-"))
  const socketPath = join(directory, "runtime.sock")
  const child = spawnLockHolder(socketPath)
  try {
    expect(await readFirstLine(child)).toBe("locked")
    await expect(acquireHostLock(socketPath)).rejects.toThrow("уже удерживается")
    child.kill("SIGKILL")
    expect(await child.exited).not.toBe(0)

    const release = await acquireHostLock(socketPath)
    await release()
    const lockPath = `${socketPath}.lock`
    const info = await lstat(lockPath)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ schemaVersion: 1, pid: process.pid, uid: process.getuid!() })
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("unlocked persistent inode можно захватить повторно без удаления", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-lock-repeat-"))
  const socketPath = join(directory, "runtime.sock")
  try {
    const first = await acquireHostLock(socketPath)
    const inode = (await lstat(`${socketPath}.lock`)).ino
    await first()
    const second = await acquireHostLock(socketPath)
    expect((await lstat(`${socketPath}.lock`)).ino).toBe(inode)
    await second()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("spawned helper не наследует host lock fd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-lock-cloexec-"))
  const socketPath = join(directory, "runtime.sock")
  const release = await acquireHostLock(socketPath)
  const child = spawnIdleChild()
  try {
    expect(await readFirstLine(child)).toBe("ready")
    await release()
    const next = await acquireHostLock(socketPath)
    await next()
  } finally {
    await release()
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("legacy owner directory нельзя молча обойти новым lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-lock-legacy-"))
  const socketPath = join(directory, "runtime.sock")
  try {
    await mkdir(`${socketPath}.owner`, { mode: 0o700 })
    await writeFile(`${socketPath}.owner/owner.json`, JSON.stringify({ pid: 999_999 }), { mode: 0o600 })
    await expect(acquireHostLock(socketPath)).rejects.toThrow("отдельного восстановления")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("symlink, directory и hard link на месте lock отклоняются", async () => {
  for (const kind of ["symlink", "directory", "hard-link"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `runtime-host-lock-${kind}-`))
    const socketPath = join(directory, "runtime.sock")
    const lockPath = `${socketPath}.lock`
    try {
      if (kind === "symlink") {
        const target = join(directory, "target")
        await writeFile(target, "foreign", { mode: 0o600 })
        await symlink(target, lockPath)
      } else if (kind === "directory") {
        await mkdir(lockPath, { mode: 0o700 })
      } else {
        const target = join(directory, "foreign")
        await writeFile(target, "foreign", { mode: 0o600 })
        await link(target, lockPath)
      }
      await expect(acquireHostLock(socketPath)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("private runtime directory обязателен", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-lock-mode-"))
  const socketPath = join(directory, "runtime.sock")
  try {
    await chmod(directory, 0o755)
    await expect(acquireHostLock(socketPath)).rejects.toThrow("доступен другим пользователям")
  } finally {
    await chmod(directory, 0o700)
    await rm(directory, { recursive: true, force: true })
  }
})

function spawnLockHolder(socketPath: string) {
  const moduleUrl = new URL("../src/host-lock.ts", import.meta.url).href
  const script = `
    import { acquireHostLock } from ${JSON.stringify(moduleUrl)}
    await acquireHostLock(process.env.TEST_SOCKET_PATH)
    console.log("locked")
    await new Promise(() => {})
  `
  return Bun.spawn([Bun.which("bun")!, "-e", script], {
    env: { ...process.env, TEST_SOCKET_PATH: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function spawnIdleChild() {
  return Bun.spawn([Bun.which("bun")!, "-e", 'console.log("ready"); await new Promise(() => {})'], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function readFirstLine(child: ReturnType<typeof spawnLockHolder> | ReturnType<typeof spawnIdleChild>) {
  const reader = child.stdout.getReader()
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lock child startup timeout")), 5000)),
  ])
  reader.releaseLock()
  if (result.done) throw new Error(await new Response(child.stderr).text())
  return new TextDecoder().decode(result.value).trim()
}
