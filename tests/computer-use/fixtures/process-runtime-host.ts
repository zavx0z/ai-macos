import { appendFileSync } from "node:fs"
import { hostname } from "node:os"
import { resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../../..")
const runtimeEntry = Bun.resolveSync("@meta/runtime", resolve(repositoryRoot, "mcp"))
const { createRuntimeHost } = await import(runtimeEntry)

const socketPath = required("ACCEPTANCE_RUNTIME_SOCKET")
const credentialPath = required("ACCEPTANCE_RUNTIME_CREDENTIAL")
const nativeStartMarker = required("ACCEPTANCE_NATIVE_START_MARKER")

try {
  const host = await createRuntimeHost({
    socketPath,
    credentialPath,
    runtimeBuildId: "runtime-build-process-acceptance",
    expectedNativeBuildId: "native-build-process-acceptance",
    loginSessionId: "login-process-acceptance",
    expectedHostname: hostname(),
    transportFactory() {
      appendFileSync(nativeStartMarker, `${process.pid}\n`)
      return {
        async send() {
          throw new Error("Injected Native unavailable after unique start boundary")
        },
        async *packets() {},
        async close() {}
      }
    }
  })
  await host.start()
  await writeReport({
    state: "ready",
    pid: process.pid,
    runtimeEpoch: host.core.generation.runtimeEpoch
  })
  await new Promise<void>((done) => {
    const stop = () => done()
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
  })
  await host.close()
} catch (error) {
  await writeReport({
    state: "blocked",
    pid: process.pid,
    message: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 23
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`)
  return value
}

async function writeReport(value: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(value)
  const middle = Math.max(1, Math.floor(line.length / 2))
  process.stdout.write(line.slice(0, middle))
  await Bun.sleep(1)
  process.stdout.write(`${line.slice(middle)}\n`)
}
