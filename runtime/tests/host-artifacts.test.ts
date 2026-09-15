import { expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reclaimStaleHostArtifacts } from "../src/host-artifacts.ts"
import { acquireHostLock } from "../src/host-lock.ts"

test("stale socket и schema-valid credential удаляются только под lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-artifacts-stale-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const child = spawnSocketHolder(socketPath)
  try {
    expect(await readFirstLine(child)).toBe("listening")
    child.kill("SIGKILL")
    expect(await child.exited).not.toBe(0)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
    await writeCredential(credentialPath)

    const release = await acquireHostLock(socketPath)
    try {
      expect(await reclaimStaleHostArtifacts(release.lease, { socketPath, credentialPath })).toEqual({ removed: ["credential", "socket"] })
      await expect(lstat(socketPath)).rejects.toThrow()
      await expect(lstat(credentialPath)).rejects.toThrow()
    } finally {
      await release()
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("active socket не считается stale и credential сохраняется", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-artifacts-active-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const server = createServer(socket => socket.end())
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject))
  await chmod(socketPath, 0o600)
  await writeCredential(credentialPath)
  const release = await acquireHostLock(socketPath)
  try {
    await expect(reclaimStaleHostArtifacts(release.lease, { socketPath, credentialPath })).rejects.toThrow("активен")
    expect((await lstat(socketPath)).isSocket()).toBe(true)
    expect(await readFile(credentialPath, "utf8")).toContain('"protocolVersion":"1"')
  } finally {
    await release()
    server.close()
    await new Promise<void>(resolve => server.once("close", resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test("foreign credential schema и symlink отклоняются без удаления", async () => {
  for (const kind of ["schema", "symlink"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `runtime-host-artifacts-${kind}-`))
    const socketPath = join(directory, "runtime.sock")
    const credentialPath = join(directory, "credential.json")
    const release = await acquireHostLock(socketPath)
    try {
      if (kind === "schema") {
        await writeFile(credentialPath, JSON.stringify({ pid: 999_999 }), { mode: 0o600 })
      } else {
        const target = join(directory, "foreign.json")
        await writeCredential(target)
        await symlink(target, credentialPath)
      }
      await expect(reclaimStaleHostArtifacts(release.lease, { socketPath, credentialPath })).rejects.toThrow()
      expect(await lstat(credentialPath)).toBeDefined()
    } finally {
      await release()
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("released lease не разрешает очистку", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-artifacts-lease-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  try {
    const release = await acquireHostLock(socketPath)
    await release()
    await writeCredential(credentialPath)
    await expect(reclaimStaleHostArtifacts(release.lease, { socketPath, credentialPath })).rejects.toThrow("lease")
    expect(await lstat(credentialPath)).toBeDefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function spawnSocketHolder(socketPath: string) {
  const script = `
    import { chmod } from "node:fs/promises"
    import { createServer } from "node:net"
    const server = createServer(socket => socket.end())
    await new Promise((resolve, reject) => server.listen(process.env.TEST_SOCKET_PATH, resolve).once("error", reject))
    await chmod(process.env.TEST_SOCKET_PATH, 0o600)
    console.log("listening")
    await new Promise(() => {})
  `
  return Bun.spawn([Bun.which("bun")!, "-e", script], {
    env: { ...process.env, TEST_SOCKET_PATH: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function writeCredential(path: string) {
  await writeFile(path, JSON.stringify({
    protocolVersion: "1",
    runtimeEpoch: "runtime:stale",
    loginSessionId: "login:stale",
    principalId: "mcp",
    bootstrapToken: "bootstrap:stale",
    adminToken: "admin:stale",
  }), { mode: 0o600 })
}

async function readFirstLine(child: ReturnType<typeof spawnSocketHolder>) {
  const reader = child.stdout.getReader()
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("socket child startup timeout")), 5000)),
  ])
  reader.releaseLock()
  if (result.done) throw new Error(await new Response(child.stderr).text())
  return new TextDecoder().decode(result.value).trim()
}
