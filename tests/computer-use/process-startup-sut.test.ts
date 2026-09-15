import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../..")
const mcpDirectory = resolve(repositoryRoot, "mcp")
const fixturePath = resolve(import.meta.dir, "fixtures/process-runtime-host.ts")
const mcpPath = resolve(mcpDirectory, "src/runtime-mcp.ts")
const clientEntry = Bun.resolveSync(
  "@modelcontextprotocol/sdk/client/index.js",
  mcpDirectory
)
const stdioEntry = Bun.resolveSync(
  "@modelcontextprotocol/sdk/client/stdio.js",
  mcpDirectory
)
const { Client } = await import(clientEntry)
const { StdioClientTransport } = await import(stdioEntry)

type ManagedConnection = {
  client: InstanceType<typeof Client>
  transport: InstanceType<typeof StdioClientTransport>
}

test("A02: два actual MCP subprocess используют один RuntimeHost и не запускают второй Native boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-process-startup-"))
  const socketPath = join(directory, "runtime.sock")
  const credentialPath = join(directory, "credential.json")
  const nativeStartMarker = join(directory, "native-starts.log")
  const env = {
    ...process.env,
    AI_MACOS_EXPECTED_HOSTNAME: hostname(),
    ACCEPTANCE_RUNTIME_SOCKET: socketPath,
    ACCEPTANCE_RUNTIME_CREDENTIAL: credentialPath,
    ACCEPTANCE_NATIVE_START_MARKER: nativeStartMarker
  }
  const managedHosts = [spawnHost(env), spawnHost(env)]
  const managedConnections: ManagedConnection[] = []
  let winner: (typeof managedHosts)[number] | undefined
  try {
    const starts = await Promise.all(managedHosts.map(readJsonLine))
    expect(starts.map((start) => start.state).sort()).toEqual(["blocked", "ready"])
    const winnerIndex = starts.findIndex((start) => start.state === "ready")
    if (winnerIndex < 0) throw new Error("RuntimeHost winner отсутствует")
    const selectedWinner = managedHosts[winnerIndex]
    const loser = managedHosts[1 - winnerIndex]
    if (selectedWinner === undefined || loser === undefined) {
      throw new Error("RuntimeHost process pair неполон")
    }
    winner = selectedWinner
    expect(await loser.exited).toBe(23)
    expect((await readFile(nativeStartMarker, "utf8")).trim().split("\n")).toHaveLength(1)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)

    const connections = await Promise.all([
      connectMcp("acceptance-process-client-a", socketPath, credentialPath, managedConnections),
      connectMcp("acceptance-process-client-b", socketPath, credentialPath, managedConnections)
    ])
    const health = await Promise.all(connections.map((connection) =>
      connection.client.callTool({ name: "system_health", arguments: {} })
    ))
    expect(health[0]?.structuredContent).toMatchObject({
      machine: { matchesExpected: true },
      runtime: { buildId: "runtime-build-process-acceptance" }
    })
    expect(health[1]?.structuredContent).toMatchObject({
      runtime: {
        buildId: "runtime-build-process-acceptance",
        runtimeEpoch: (health[0]?.structuredContent as any)?.runtime?.runtimeEpoch
      }
    })

    await cleanupConnections(managedConnections)
    selectedWinner.kill("SIGTERM")
    expect(await selectedWinner.exited).toBe(0)
    winner = undefined

    const foreign = Bun.serve({
      unix: socketPath,
      fetch: () => new Response("foreign-listener")
    })
    try {
      const blocked = spawnHost(env)
      managedHosts.push(blocked)
      const state = await readJsonLine(blocked)
      expect(state).toMatchObject({ state: "blocked" })
      expect(await blocked.exited).toBe(23)
      expect(await (await fetch("http://localhost/", { unix: socketPath })).text())
        .toBe("foreign-listener")
      expect((await readFile(nativeStartMarker, "utf8")).trim().split("\n")).toHaveLength(1)
    } finally {
      foreign.stop(true)
    }
  } finally {
    await cleanupConnections(managedConnections)
    for (const host of managedHosts) {
      if (host.exitCode === null) host.kill("SIGKILL")
      await host.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

function spawnHost(env: Record<string, string | undefined>) {
  return Bun.spawn([process.execPath, fixturePath], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe"
  })
}

async function readJsonLine(child: ReturnType<typeof spawnHost>): Promise<any> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const maximumBytes = 16 * 1024
  let receivedBytes = 0
  let text = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Runtime host subprocess startup timeout")),
      5000
    )
  })
  try {
    while (true) {
      const item = await Promise.race([reader.read(), timeout])
      if (item.done) throw new Error(await new Response(child.stderr).text())
      receivedBytes += item.value.byteLength
      if (receivedBytes > maximumBytes) throw new Error("Runtime host startup JSON превышает byte limit")
      text += decoder.decode(item.value, { stream: true })
      const newline = text.indexOf("\n")
      if (newline >= 0) return JSON.parse(text.slice(0, newline))
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    await reader.cancel("startup line received").catch(() => undefined)
    reader.releaseLock()
  }
}

async function connectMcp(
  name: string,
  socketPath: string,
  credentialPath: string,
  managedConnections: ManagedConnection[]
) {
  const client = new Client({ name, version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    env: {
      ...process.env,
      AI_MACOS_EXPECTED_HOSTNAME: hostname(),
      META_RUNTIME_SOCKET: socketPath,
      META_RUNTIME_CREDENTIAL: credentialPath
    },
    stderr: "pipe"
  })
  managedConnections.push({ client, transport })
  await client.connect(transport)
  return { client, transport }
}

async function cleanupConnections(connections: ManagedConnection[]): Promise<void> {
  const current = connections.splice(0)
  await Promise.allSettled(current.map(async ({ client, transport }) => {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }))
}
