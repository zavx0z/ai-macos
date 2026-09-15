import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export async function acquireHostLock(socketPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const lockPath = `${socketPath}.owner`
  await mkdir(lockPath, { mode: 0o700 })
  let released = false
  try {
    await writeFile(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }), { flag: "wx", mode: 0o600 })
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
  return async () => {
    if (released) return
    released = true
    await rm(lockPath, { recursive: true, force: true })
  }
}
