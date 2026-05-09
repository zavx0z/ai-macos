import { spawn } from "bun"
import { adbAvailable, adbDevices, adbForward, type AdbDevice } from "./adb.ts"

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
  brew: boolean
  device: AdbDevice | null
  forward: boolean
  cdp: boolean
  browser?: string
  error?: string
  hint?: string
}

async function which(cmd: string): Promise<boolean> {
  try {
    const proc = spawn(["sh", "-c", `command -v ${cmd}`], { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

async function brewInstall(cask: string): Promise<boolean> {
  console.log(`  ${D}запускаю: brew install --cask ${cask}${RESET}`)
  const proc = spawn(["brew", "install", "--cask", cask], { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  return code === 0
}

async function fail(status: Partial<BootstrapStatus>, hint: string, error?: string): Promise<BootstrapStatus> {
  console.log(`  ${D}↳ ${hint}${RESET}\n`)
  return {
    adb: false, brew: false, device: null, forward: false, cdp: false,
    ...status, hint, error,
  }
}

export async function bootstrap(autoInstall = true): Promise<BootstrapStatus> {
  console.log()
  console.log(`  ${C}@meta/android bootstrap${RESET}`)

  // 1) adb
  let adb = await adbAvailable()
  let brew = false
  if (!adb) {
    console.log(`  ${ERR} adb не найден`)
    brew = await which("brew")
    if (!brew) {
      console.log(`  ${ERR} brew не найден`)
      return await fail({}, "Установите Homebrew (https://brew.sh), затем brew install --cask android-platform-tools")
    }
    console.log(`  ${OK} brew доступен`)
    if (!autoInstall) {
      return await fail({ brew }, "Запустите вручную: brew install --cask android-platform-tools")
    }
    const installed = await brewInstall("android-platform-tools")
    adb = installed && (await adbAvailable())
    if (!adb) {
      return await fail({ brew }, "Установка через brew не удалась — выполните вручную и проверьте PATH")
    }
    console.log(`  ${OK} android-platform-tools установлен`)
  } else {
    console.log(`  ${OK} adb`)
    brew = true // если adb уже есть, brew не нужен — статус просто маркируем true чтобы не путать
  }

  // 2) Devices
  let devices: AdbDevice[] = []
  try {
    devices = await adbDevices()
  } catch (e) {
    return await fail({ adb, brew }, "Не удалось получить список устройств. Проверьте: adb kill-server && adb start-server",
      e instanceof Error ? e.message : String(e))
  }

  if (devices.length === 0) {
    return await fail({ adb, brew }, "Подключите телефон по USB. На телефоне: Settings → Developer options → USB Debugging ✅")
  }

  const ready = devices.find((d) => d.state === "device")
  const unauthorized = devices.find((d) => d.state === "unauthorized")
  const offline = devices.find((d) => d.state === "offline")

  if (!ready) {
    if (unauthorized) {
      console.log(`  ${WARN} устройство ${unauthorized.serial} (unauthorized)`)
      return await fail({ adb, brew, device: unauthorized },
        "Примите диалог 'Allow USB debugging' на экране телефона. Если не появляется — отключите/подключите кабель")
    }
    if (offline) {
      console.log(`  ${WARN} устройство ${offline.serial} (offline)`)
      return await fail({ adb, brew, device: offline },
        "Устройство offline. Перезагрузите телефон или выполните: adb kill-server && adb start-server")
    }
    return await fail({ adb, brew, device: devices[0] ?? null },
      `Нет устройств в состоянии 'device' (есть: ${devices.map((d) => `${d.serial}=${d.state}`).join(", ")})`)
  }

  console.log(`  ${OK} устройство ${ready.serial}`)

  // 3) Forward
  try {
    await adbForward(9222, ready.serial)
    console.log(`  ${OK} adb forward tcp:9222 → chrome_devtools_remote`)
  } catch (e) {
    return await fail({ adb, brew, device: ready },
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
    return { adb, brew, device: ready, forward: true, cdp: true, browser: v.Browser }
  } catch (e) {
    return await fail({ adb, brew, device: ready, forward: true },
      "Chrome не отвечает на CDP. Откройте Chrome на телефоне (с открытой вкладкой), затем GET /health",
      e instanceof Error ? e.message : String(e))
  }
}
