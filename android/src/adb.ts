import { spawn } from "bun"

export const DEFAULT_DEBUG_PORT = 9222

export type AdbDevice = {
  serial: string
  state: string
}

async function run(cmd: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

export async function adbDevices(): Promise<AdbDevice[]> {
  const { stdout, stderr, code } = await run(["adb", "devices"])
  if (code !== 0) throw new Error(`adb devices failed: ${stderr.trim()}`)
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((l) => l.length > 0 && l.includes("\t"))
    .map((line) => {
      const [serial, state] = line.split("\t")
      return { serial: serial!, state: state ?? "unknown" }
    })
}

export async function adbForward(localPort: number = DEFAULT_DEBUG_PORT, serial?: string): Promise<void> {
  const cmd = ["adb"]
  if (serial) cmd.push("-s", serial)
  cmd.push("forward", `tcp:${localPort}`, "localabstract:chrome_devtools_remote")
  const { stderr, code } = await run(cmd)
  if (code !== 0) throw new Error(`adb forward failed: ${stderr.trim()}`)
}

export async function adbForwardList(): Promise<string[]> {
  const { stdout, code } = await run(["adb", "forward", "--list"])
  if (code !== 0) return []
  return stdout.split("\n").filter((l) => l.trim().length > 0)
}

export async function adbAvailable(): Promise<boolean> {
  try {
    const { code } = await run(["adb", "version"])
    return code === 0
  } catch {
    return false
  }
}
