import { createRuntimeHost } from "./host.ts"
import { RuntimeUdsClient } from "./transport.ts"
import { parseBrowserHostConfig } from "./browser-config.ts"

declare const __META_RUNTIME_BUILD_ID__: string | undefined
const embeddedBuildId = typeof __META_RUNTIME_BUILD_ID__ === "undefined" ? undefined : __META_RUNTIME_BUILD_ID__

export type RuntimeShutdownHost = { drain(): Promise<unknown>, close(): Promise<void> }

/** Close выполняется независимо от результата drain; clean shutdown не подменяет ошибку drain. */
export async function shutdownRuntimeHost(host: RuntimeShutdownHost): Promise<void> {
  const errors: Error[] = []
  try { await host.drain() }
  catch (cause) { errors.push(new Error("Runtime drain не подтверждён", { cause })) }
  try { await host.close() }
  catch (cause) { errors.push(new Error("Runtime close не подтверждён", { cause })) }
  if (errors.length > 0) throw new AggregateError(errors, "Runtime shutdown завершил доступные этапы с ошибками")
}

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
    expectedNativeCdhash: required("META_NATIVE_CDHASH"),
    browser: parseBrowserHostConfig(process.env.META_RUNTIME_BROWSER_CONFIG),
    managed: process.env.META_RUNTIME_MANAGED === "true",
    startupPermissions: { mode: "request-missing" },
    ...(process.env.META_RUNTIME_STATE_DIR === undefined ? {} : { stateDirectory: process.env.META_RUNTIME_STATE_DIR }),
    expectedHostname: required("AI_MACOS_EXPECTED_HOSTNAME"), helperPath: required("META_NATIVE_HELPER"),
  })
  await host.start()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void shutdownRuntimeHost(host).catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}

if (import.meta.main) void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
