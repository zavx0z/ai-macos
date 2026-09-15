import { createRuntimeHost } from "./host.ts"
import { RuntimeUdsClient } from "./transport.ts"

declare const __META_RUNTIME_BUILD_ID__: string | undefined
const embeddedBuildId = typeof __META_RUNTIME_BUILD_ID__ === "undefined" ? undefined : __META_RUNTIME_BUILD_ID__

export async function main(): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name]
    if (!value) throw new Error(`Отсутствует ${name}`)
    return value
  }
  if (process.argv.includes("--doctor")) {
    const client = await RuntimeUdsClient.fromCredentialFile(required("META_RUNTIME_SOCKET"), required("META_RUNTIME_CREDENTIAL"))
    await client.open("runtime-doctor")
    try {
      const result = await client.callTool("system_health", {}, AbortSignal.timeout(5000))
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.isError) process.exitCode = 1
    } finally { await client.close() }
    return
  }
  const host = await createRuntimeHost({
    socketPath: required("META_RUNTIME_SOCKET"), credentialPath: required("META_RUNTIME_CREDENTIAL"),
    runtimeBuildId: embeddedBuildId ?? required("META_RUNTIME_BUILD_ID"),
    expectedNativeBuildId: required("META_NATIVE_BUILD_ID"),
    ...(process.env.META_RUNTIME_STATE_DIR === undefined ? {} : { stateDirectory: process.env.META_RUNTIME_STATE_DIR }),
    expectedHostname: required("AI_MACOS_EXPECTED_HOSTNAME"), helperPath: required("META_NATIVE_HELPER"),
  })
  await host.start()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void host.drain().then(() => host.close()).catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}

if (import.meta.main) void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
