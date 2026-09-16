import { hostname } from "node:os"
import { RuntimeUdsClient } from "@meta/runtime"
import { assertRuntimeCompatible, assertToolAllowed, createCatalogSnapshot, type CatalogSnapshot } from "./catalog-snapshot.ts"

export interface ChatRuntimeOptions {
  expectedHostname: string
  socketPath: string
  credentialPath: string
}

/** Ленивый исполнитель: проверяет машину и контракт, не повторяет операции. */
export function createChatExecutor(snapshot: CatalogSnapshot, options: ChatRuntimeOptions) {
  let client: RuntimeUdsClient | undefined
  let connecting: Promise<RuntimeUdsClient> | undefined
  let closed = false
  const contracts = new Map(snapshot.tools.map(tool => [tool.name,
    createCatalogSnapshot(snapshot.runtimeBuildId, snapshot.tools, [tool.name])]))
  const checkHealth = async (current: RuntimeUdsClient, signal: AbortSignal) => {
    const health = await current.callTool("system_health", {}, signal)
    const machine = health.structuredContent?.machine as { matchesExpected?: boolean, hostname?: string } | undefined
    if (health.isError || machine?.matchesExpected !== true || machine.hostname !== options.expectedHostname) {
      throw new Error("Машина Runtime не подтверждена")
    }
    return health
  }
  const connect = async () => {
    if (closed) throw new Error("Исполнитель закрыт")
    if (hostname() !== options.expectedHostname) throw new Error("Машина прокси не совпадает с ожидаемой")
    if (client) return client
    connecting ??= (async () => {
      const candidate = await RuntimeUdsClient.fromCredentialFile(options.socketPath, options.credentialPath)
      try {
        await candidate.open(`chat-proxy:${process.pid}`)
        await checkHealth(candidate, AbortSignal.timeout(5000))
        if (closed) throw new Error("Исполнитель закрыт")
        client = candidate
        return candidate
      } catch (error) {
        await candidate.close().catch(() => undefined)
        throw error
      }
    })().finally(() => { connecting = undefined })
    return connecting
  }
  return {
    async call(action: string, input: Record<string, unknown>, signal: AbortSignal) {
      assertToolAllowed(snapshot, action)
      signal.throwIfAborted()
      const current = await connect()
      signal.throwIfAborted()
      const health = await checkHealth(current, signal)
      if (action === "system_health") return health
      const identity = health.structuredContent?.runtime as { buildId?: string, runtimeEpoch?: string } | undefined
      if (!identity?.buildId || !identity.runtimeEpoch) throw new Error("Identity Runtime недоступна")
      // Только вызываемый контракт: недоступность ввода не блокирует status/cancel.
      assertRuntimeCompatible(contracts.get(action)!, identity.buildId, await current.listTools())
      const after = await current.health() as { generation?: { runtimeEpoch?: string } }
      if (after.generation?.runtimeEpoch !== identity.runtimeEpoch) throw new Error("Runtime сменился во время проверки")
      signal.throwIfAborted()
      return await current.callTool(action, input, signal)
    },
    async close() {
      closed = true
      await connecting?.catch(() => undefined)
      await client?.close()
    },
  }
}
