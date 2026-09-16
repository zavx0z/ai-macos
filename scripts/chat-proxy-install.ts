import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { probeChatProxy } from "../mcp/src/chat-proxy-probe.ts"

export interface ProxyUpdateSteps {
  prepare(): Promise<void>
  stop(): Promise<void>
  replace(): Promise<void>
  start(): Promise<void>
  verify(): Promise<void>
  restore(): Promise<void>
  record(phase: string): Promise<void>
}

/** Замена выполняется только после остановки всей tunnel session; один rollback без повторов. */
export async function updateManagedProxy(steps: ProxyUpdateSteps) {
  await steps.prepare()
  await steps.record("prepared")
  await steps.stop()
  try {
    await steps.record("stopped")
    await steps.replace()
    await steps.record("replaced")
    await steps.start()
    await steps.verify()
    await steps.record("installed")
  } catch (cause) {
    try {
      await steps.stop()
      await steps.restore()
      await steps.start()
      await steps.verify()
      await steps.record("rolled-back")
    } catch (rollbackError) {
      throw new AggregateError([cause, rollbackError], "Обновление и rollback прокси не завершены; проверьте update.json")
    }
    throw new Error("Обновление прокси не прошло; прежняя копия восстановлена", { cause })
  }
}

function quote(value: string) {
  return /^[A-Za-z0-9_/.=:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`
}

async function run(command: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000) {
  const process = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => process.kill("SIGTERM"), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ])
    if (exitCode !== 0) {
      // Ответы credential/tunnel CLI могут содержать чувствительные сведения.
      throw new Error(`Команда ${command[0]} завершилась с кодом ${exitCode}${command[1] === "build" ? `: ${stderr}` : ""}`)
    }
    return stdout
  } finally { clearTimeout(timer) }
}

async function digest(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function cli() {
  const repository = resolve(fileURLToPath(new URL("../", import.meta.url)))
  if (repository !== join(homedir(), "repozitarium/ai-macos")) throw new Error("Требуется canonical checkout ai-macos")
  const base = join(homedir(), "Library/Application Support")
  const installRoot = join(base, "ai-macos/chat-proxy")
  const profiles = join(base, "ai-macos/tunnel/profiles")
  const profilePath = join(profiles, "ai-macos-chat.yaml")
  const profile = Bun.YAML.parse(await readFile(profilePath, "utf8")) as {
    control_plane: { tunnel_id: string, api_key: string }
    mcp: { commands: Array<{ channel: string, command: string }> }
  }
  const executable = join(installRoot, "zavx0z-mcp")
  const candidate = join(installRoot, "zavx0z-mcp.candidate")
  const backup = join(installRoot, "zavx0z-mcp.rollback")
  const tunnel = join(base, "knowledge-base/tunnel/bin/tunnel-client")
  const proxyEnv = {
    AI_MACOS_EXPECTED_HOSTNAME: hostname(),
    META_RUNTIME_SOCKET: join(base, "ai-macos/run/runtime.sock"),
    META_RUNTIME_CREDENTIAL: join(base, "ai-macos/run/credential.json"),
  }
  const command = ["/usr/bin/env", ...Object.entries(proxyEnv).map(([key, value]) => `${key}=${value}`), executable].map(quote).join(" ")
  if (profile.mcp.commands.length !== 1 || profile.mcp.commands[0]?.channel !== "main"
    || profile.mcp.commands[0]?.command !== command
    || !/^tunnel_[a-zA-Z0-9]+$/.test(profile.control_plane.tunnel_id)) {
    throw new Error("Установленный профиль не совпадает с ожидаемым ai-macos-chat; автоматическая подмена запрещена")
  }
  const sourceCommit = (await run(["git", "-C", repository, "rev-parse", "HEAD"])).trim()
  const clean = (await run(["git", "-C", repository, "status", "--porcelain"])).trim() === ""
  const previousSha256 = await digest(executable)
  const plan = { sourceCommit, clean, profilePath, executable, previousSha256,
    steps: ["build", "probe", "stop-session", "replace", "connect-session", "verify", "receipt"] }
  console.log(JSON.stringify(plan, null, 2))
  if (!process.argv.includes("--execute")) return
  if (!clean) throw new Error("Установка требует чистый canonical checkout")

  const env = { ...process.env }
  const reference = profile.control_plane.api_key
  if (reference.startsWith("env:")) {
    const name = reference.slice(4)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("Некорректная ссылка на credential")
    if (!env[name]) {
      const index = process.argv.indexOf("--credential-service")
      const service = index < 0 ? undefined : process.argv[index + 1]
      if (!service) throw new Error(`Нужен ${name} или --credential-service существующей записи Keychain`)
      env[name] = (await run(["/usr/bin/security", "find-generic-password", "-a", process.env.USER!, "-s", service, "-w"])).trim()
    }
  } else if (!reference.startsWith("file:")) {
    throw new Error("Ожидается credential reference env: или file:")
  }
  const status = async () => JSON.parse(await run([tunnel, "runtimes", "status", "ai-macos-chat", "--json"], env)) as {
    process_running: boolean, healthy: boolean, ready: boolean, stale: boolean,
    process?: { target_value?: string },
  }
  const current = await status()
  if (current.process?.target_value !== command) throw new Error("Alias управляет другой командой")
  const lock = join(installRoot, "update.lock")
  await mkdir(lock)
  let candidateSha256 = ""
  const originalProfile = await readFile(profilePath)
  const record = async (phase: string) => {
    const receipt = { ...plan, candidateSha256, phase, recordedAt: new Date().toISOString() }
    const path = join(installRoot, "update.json")
    await writeFile(`${path}.next`, JSON.stringify(receipt, null, 2), { mode: 0o600 })
    await rename(`${path}.next`, path)
  }
  try {
    await updateManagedProxy({
      async prepare() {
        await run([process.execPath, "build", join(repository, "mcp/src/chat-proxy.ts"), "--compile", "--outfile", candidate])
        await chmod(candidate, 0o700)
        await probeChatProxy(candidate, proxyEnv)
        candidateSha256 = await digest(candidate)
        if ((await run(["git", "-C", repository, "status", "--porcelain"])).trim()
          || (await run(["git", "-C", repository, "rev-parse", "HEAD"])).trim() !== sourceCommit) {
          throw new Error("Исходники изменились во время сборки; работающая session не остановлена")
        }
        if (await digest(executable) !== previousSha256) throw new Error("Установленный прокси изменился во время сборки")
        await copyFile(executable, backup)
        await chmod(backup, 0o700)
      },
      async stop() {
        await run([tunnel, "runtimes", "stop", "ai-macos-chat", "--json"], env)
        if ((await status()).process_running) throw new Error("Остановка tunnel session не подтверждена")
      },
      async replace() { await rename(candidate, executable) },
      async start() {
        await run([tunnel, "runtimes", "connect", "--alias", "ai-macos-chat", "--tunnel-id", profile.control_plane.tunnel_id,
          "--profile", "ai-macos-chat", "--profile-dir", profiles, "--runtime-api-key", reference, "--mcp-command", command, "--json"], env)
      },
      async verify() {
        for (let check = 0; check < 2; check++) {
          if (check > 0) await Bun.sleep(1500)
          const state = await status()
          if (!state.process_running || !state.healthy || !state.ready || state.stale) throw new Error("Tunnel session не готова")
        }
        if (!(await readFile(profilePath)).equals(originalProfile)) throw new Error("Профиль изменился при reconnect")
      },
      async restore() {
        await copyFile(backup, candidate)
        await chmod(candidate, 0o700)
        await rename(candidate, executable)
        if (await digest(executable) !== previousSha256) throw new Error("Rollback digest не совпал")
      },
      record,
    })
    console.log(JSON.stringify({ state: "installed", sourceCommit, sha256: candidateSha256, tunnel: "ai-macos-chat", ready: true }))
  } finally {
    await rm(candidate, { force: true })
    await rm(lock, { recursive: true })
  }
}

if (import.meta.main) await cli()
