import { spawn } from "bun"
import { adbAvailable, adbDevices, adbForward, adbKillServer, adbStartServer, type AdbDevice } from "./adb.ts"

const G = "\x1b[32m"
const Y = "\x1b[33m"
const R = "\x1b[31m"
const D = "\x1b[2m"
const C = "\x1b[36m"
const RESET = "\x1b[0m"

const OK = `${G}✓${RESET}`
const WARN = `${Y}!${RESET}`
const ERR = `${R}✗${RESET}`

export type BootstrapStatus = {
  adb: boolean
  packageManager: "brew" | "port" | null
  device: AdbDevice | null
  forward: boolean
  cdp: boolean
  browser?: string
  error?: string
  hint?: string
}

async function which(cmd: string): Promise<string | null> {
  // common locations + sh PATH lookup
  const candidates = [
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin",
  ].map((d) => `${d}/${cmd}`)
  for (const path of candidates) {
    try {
      const file = Bun.file(path)
      if (await file.exists()) return path
    } catch {/* ignore */}
  }
  try {
    const proc = spawn(["sh", "-lc", `command -v ${cmd}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const path = out.trim()
    if (path.length > 0) return path
  } catch {/* ignore */}
  return null
}

async function brewInstall(brewPath: string, cask: string): Promise<boolean> {
  console.log(`  ${D}запускаю: ${brewPath} install --cask ${cask}${RESET}`)
  const proc = spawn([brewPath, "install", "--cask", cask], { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  return code === 0
}

async function portInstallWithPrompt(portPath: string, name: string): Promise<boolean> {
  console.log(`  ${D}запускаю: sudo ${portPath} install ${name} (откроется диалог macOS для пароля)${RESET}`)
  // osascript with admin privileges → native macOS password dialog
  const script = `do shell script "${portPath} install -N ${name}" with administrator privileges`
  const proc = spawn(["osascript", "-e", script], { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  return code === 0
}

async function fail(status: Partial<BootstrapStatus>, hint: string, error?: string): Promise<BootstrapStatus> {
  console.log(`  ${D}↳ ${hint}${RESET}\n`)
  return {
    adb: false, packageManager: null, device: null, forward: false, cdp: false,
    ...status, hint, error,
  }
}

export async function bootstrap(autoInstall = true): Promise<BootstrapStatus> {
  console.log()
  console.log(`  ${C}@meta/android bootstrap${RESET}`)

  // 1) adb
  let adb = await adbAvailable()
  let pm: "brew" | "port" | null = null
  if (!adb) {
    console.log(`  ${ERR} adb не найден`)
    const brewPath = await which("brew")
    const portPath = await which("port")
    if (brewPath) {
      pm = "brew"
      console.log(`  ${OK} brew (${brewPath})`)
    } else if (portPath) {
      pm = "port"
      console.log(`  ${OK} MacPorts (${portPath})`)
    } else {
      console.log(`  ${ERR} ни brew, ни MacPorts не найдены`)
      return await fail({},
        "Установите Homebrew (https://brew.sh) или MacPorts, затем android-platform-tools")
    }
    if (!autoInstall) {
      const cmd = pm === "brew"
        ? "brew install --cask android-platform-tools"
        : "sudo port install android-platform-tools"
      return await fail({ packageManager: pm }, `Запустите вручную: ${cmd}`)
    }
    const installed = pm === "brew"
      ? await brewInstall(brewPath!, "android-platform-tools")
      : await portInstallWithPrompt(portPath!, "android-platform-tools")
    adb = installed && (await adbAvailable())
    if (!adb) {
      return await fail({ packageManager: pm },
        pm === "brew"
          ? "Установка через brew не удалась — попробуйте вручную: brew install --cask android-platform-tools"
          : "Установка через MacPorts не удалась — попробуйте вручную: sudo port install android-platform-tools")
    }
    console.log(`  ${OK} android-platform-tools установлен`)
  } else {
    console.log(`  ${OK} adb`)
    // detect pm just for reporting
    if (await which("brew")) pm = "brew"
    else if (await which("port")) pm = "port"
  }

  // 2) Start daemon explicitly to avoid race when multiple adb processes try to bring it up
  await adbStartServer().catch(() => {/* ignore — daemon may already be running */})

  // 3) Devices (with retry on transient daemon startup race)
  let devices: AdbDevice[] = []
  try {
    devices = await adbDevices()
  } catch (e) {
    // Single retry: kill the half-started daemon, restart, list again
    try {
      await adbKillServer()
      await new Promise((r) => setTimeout(r, 300))
      await adbStartServer()
      devices = await adbDevices()
    } catch (e2) {
      return await fail({ adb, packageManager: pm }, "Не удалось получить список устройств. Проверьте порт 5037: lsof -i :5037",
        e2 instanceof Error ? e2.message : String(e2))
    }
  }

  if (devices.length === 0) {
    return await fail({ adb, packageManager: pm }, "Подключите телефон по USB. На телефоне: Settings → Developer options → USB Debugging ✅")
  }

  const ready = devices.find((d) => d.state === "device")
  const unauthorized = devices.find((d) => d.state === "unauthorized")
  const offline = devices.find((d) => d.state === "offline")

  if (!ready) {
    if (unauthorized) {
      console.log(`  ${WARN} устройство ${unauthorized.serial} (unauthorized)`)
      return await fail({ adb, packageManager: pm, device: unauthorized },
        "Примите диалог 'Allow USB debugging' на экране телефона. Если не появляется — отключите/подключите кабель")
    }
    if (offline) {
      console.log(`  ${WARN} устройство ${offline.serial} (offline)`)
      return await fail({ adb, packageManager: pm, device: offline },
        "Устройство offline. Перезагрузите телефон или выполните: adb kill-server && adb start-server")
    }
    return await fail({ adb, packageManager: pm, device: devices[0] ?? null },
      `Нет устройств в состоянии 'device' (есть: ${devices.map((d) => `${d.serial}=${d.state}`).join(", ")})`)
  }

  console.log(`  ${OK} устройство ${ready.serial}`)

  // 3) Forward
  try {
    await adbForward(9222, ready.serial)
    console.log(`  ${OK} adb forward tcp:9222 → chrome_devtools_remote`)
  } catch (e) {
    return await fail({ adb, packageManager: pm, device: ready },
      "Не удалось пробросить порт. Откройте Chrome на телефоне (хотя бы одну вкладку), затем POST /forward",
      e instanceof Error ? e.message : String(e))
  }

  // 4) CDP reachable
  try {
    const r = await fetch("http://localhost:9222/json/version")
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const v = (await r.json()) as { Browser?: string; "User-Agent"?: string }
    console.log(`  ${OK} Chrome: ${v.Browser ?? "unknown"}`)
    console.log()
    return { adb, packageManager: pm, device: ready, forward: true, cdp: true, browser: v.Browser }
  } catch (e) {
    return await fail({ adb, packageManager: pm, device: ready, forward: true },
      "Chrome не отвечает на CDP. Откройте Chrome на телефоне (с открытой вкладкой), затем GET /health",
      e instanceof Error ? e.message : String(e))
  }
}
