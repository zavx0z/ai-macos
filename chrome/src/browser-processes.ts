import {spawn} from "bun"

const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

export type ChromeBrowserProcess = Readonly<{
  pid: number
  profile: "default" | "cdp" | "custom"
  remoteDebugging: boolean
  userDataDir: string | null
}>

export class ChromeProcessAmbiguityError extends Error {
  readonly status = 409 as const

  constructor(readonly processes: readonly ChromeBrowserProcess[]) {
    const identities = processes
      .map((process) => `pid ${process.pid} (${process.profile})`)
      .join(", ")
    super(
      `Multiple Google Chrome browser processes are running: ${identities}. ` +
      "AppleScript cannot select an exact Chrome profile; use targetId from GET /cdp/targets.",
    )
    this.name = "ChromeProcessAmbiguityError"
  }
}

export function parseChromeBrowserProcesses(output: string): ChromeBrowserProcess[] {
  const processes: ChromeBrowserProcess[] = []
  for (const line of output.split("\n")) {
    const row = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!row) continue
    const pid = Number(row[1])
    const command = row[2] ?? ""
    if (!Number.isSafeInteger(pid) || pid <= 0 || !command.startsWith(CHROME_EXECUTABLE)) continue
    const suffix = command.slice(CHROME_EXECUTABLE.length)
    if (suffix && !/^\s/.test(suffix)) continue
    const remoteDebugging = /(?:^|\s)--remote-debugging-(?:port|pipe)(?:=|\s|$)/.test(suffix)
    const userDataDir = optionValue(suffix, "user-data-dir")
    processes.push({
      pid,
      profile: remoteDebugging ? "cdp" : userDataDir ? "custom" : "default",
      remoteDebugging,
      userDataDir,
    })
  }
  return processes.sort((left, right) => left.pid - right.pid)
}

export async function listChromeBrowserProcesses(): Promise<ChromeBrowserProcess[]> {
  const process = spawn(["ps", "-axo", "pid=,args="], {stdout: "pipe", stderr: "pipe"})
  const [output, code] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`Could not inspect Google Chrome processes (ps exit ${code})`)
  return parseChromeBrowserProcesses(output)
}

export async function assertUnambiguousChromeProcess(): Promise<void> {
  assertUnambiguousChromeProcesses(await listChromeBrowserProcesses())
}

export function assertUnambiguousChromeProcesses(
  processes: readonly ChromeBrowserProcess[],
): void {
  if (processes.length > 1) throw new ChromeProcessAmbiguityError(processes)
}

function optionValue(command: string, name: string): string | null {
  const match = command.match(new RegExp(`(?:^|\\s)--${name}=([^\\n]*?)(?=\\s--|$)`))
  const value = match?.[1]?.trim() ?? ""
  return value || null
}
