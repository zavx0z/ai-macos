import { spawn } from "bun"

const G = "\x1b[32m"
const Y = "\x1b[33m"
const D = "\x1b[2m"
const C = "\x1b[36m"
const RESET = "\x1b[0m"

const OK = `${G}✓${RESET}`
const WARN = `${Y}!${RESET}`

export type InputBootstrapStatus = {
  cliclick: string | null
  python3: string | null
  packageManager: "brew" | "port" | null
  accessibility: boolean
  hint?: string
}

/**
 * Молчаливый тест Accessibility: пытаемся подвинуть курсор обратно туда же.
 * Если процесс не имеет Accessibility, cliclick exit=0 но реально ничего не делает.
 */
async function probeAccessibility(cliclick: string): Promise<boolean> {
  try {
    const before = spawn([cliclick, "p"], { stdout: "pipe", stderr: "pipe" })
    const outBefore = (await new Response(before.stdout).text()).trim()
    await before.exited
    const [bx, by] = outBefore.split(",").map(Number)
    if (bx == null || by == null) return false

    // Двигаем на 1 пиксель вправо, читаем, возвращаем
    const target = `${bx + 1},${by}`
    await spawn([cliclick, `m:${target}`], { stdout: "pipe", stderr: "pipe" }).exited
    await new Promise((r) => setTimeout(r, 80))
    const after = spawn([cliclick, "p"], { stdout: "pipe", stderr: "pipe" })
    const outAfter = (await new Response(after.stdout).text()).trim()
    await after.exited
    // Возвращаем на место
    await spawn([cliclick, `m:${bx},${by}`], { stdout: "pipe", stderr: "pipe" }).exited

    const [ax] = outAfter.split(",").map(Number)
    return ax === bx + 1
  } catch {
    return false
  }
}

async function which(cmd: string): Promise<string | null> {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]) {
    const p = `${dir}/${cmd}`
    try {
      const f = Bun.file(p)
      if (await f.exists()) return p
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

async function pythonHasQuartz(pythonPath: string): Promise<boolean> {
  try {
    const proc = spawn([pythonPath, "-c", "import Quartz"], { stdout: "pipe", stderr: "pipe" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

async function detectPackageManager(): Promise<"brew" | "port" | null> {
  if (await which("brew")) return "brew"
  if (await which("port")) return "port"
  return null
}

async function installCliclick(pm: "brew" | "port"): Promise<boolean> {
  if (pm === "brew") {
    const brewPath = await which("brew")
    if (!brewPath) return false
    console.log(`  ${D}запускаю: ${brewPath} install cliclick${RESET}`)
    const proc = spawn([brewPath, "install", "cliclick"], { stdout: "inherit", stderr: "inherit" })
    return (await proc.exited) === 0
  }
  const portPath = await which("port")
  if (!portPath) return false
  console.log(`  ${D}запускаю: sudo ${portPath} install cliclick (диалог пароля macOS)${RESET}`)
  const script = `do shell script "${portPath} install -N cliclick" with administrator privileges`
  const proc = spawn(["osascript", "-e", script], { stdout: "inherit", stderr: "inherit" })
  return (await proc.exited) === 0
}

export async function bootstrap(autoInstall = true): Promise<InputBootstrapStatus> {
  console.log()
  console.log(`  ${C}@meta/input bootstrap${RESET}`)

  const pythonRaw = await which("python3")
  let python3: string | null = null
  if (pythonRaw && (await pythonHasQuartz(pythonRaw))) {
    python3 = pythonRaw
    console.log(`  ${OK} python3+Quartz (${python3})  — доступен fallback для мыши`)
  } else if (pythonRaw) {
    console.log(`  ${WARN} python3 без модуля Quartz (PyObjC не установлен) — используется только cliclick`)
  }

  let cliclick = await which("cliclick")
  const pm = await detectPackageManager()

  if (cliclick) {
    console.log(`  ${OK} cliclick (${cliclick})`)
    const acc = await probeAccessibility(cliclick)
    if (acc) {
      console.log(`  ${OK} Accessibility разрешён`)
      console.log()
      return { cliclick, python3, packageManager: pm, accessibility: true }
    }
    console.log(`  ${WARN} Accessibility не выдан процессу bun/терминалу`)
    console.log(`  ${D}↳ Откройте: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'${RESET}`)
    console.log(`  ${D}  Добавьте: ваш терминал (iTerm/Terminal) или сам бинарник bun${RESET}`)
    console.log()
    return { cliclick, python3, packageManager: pm, accessibility: false,
      hint: "Выдайте Accessibility терминалу/bun: System Settings → Privacy → Accessibility (или GET http://localhost:7882/permissions/accessibility)" }
  }

  console.log(`  ${WARN} cliclick не установлен (рекомендуется для надёжной работы с мышью)`)

  if (!autoInstall) {
    return { cliclick: null, python3, packageManager: pm, accessibility: false,
      hint: pm === "brew" ? "brew install cliclick" : pm === "port" ? "sudo port install cliclick" : "Установите brew или MacPorts, затем cliclick" }
  }

  if (!pm) {
    console.log(`  ${WARN} brew/port не найдены — cliclick недоступен`)
    console.log()
    return { cliclick: null, python3, packageManager: null, accessibility: false }
  }

  const ok = await installCliclick(pm)
  if (ok) {
    cliclick = await which("cliclick")
    if (cliclick) {
      console.log(`  ${OK} cliclick установлен (${cliclick})`)
      const acc = await probeAccessibility(cliclick)
      if (!acc) {
        console.log(`  ${WARN} Accessibility не выдан — выдайте в System Settings → Privacy → Accessibility`)
      }
      console.log()
      return { cliclick, python3, packageManager: pm, accessibility: acc,
        hint: acc ? undefined : "Выдайте Accessibility терминалу/bun" }
    }
  }

  console.log(`  ${WARN} установка cliclick не удалась — работаем без него`)
  console.log()
  return { cliclick: null, python3, packageManager: pm, accessibility: false,
    hint: pm === "brew" ? "Попробуйте вручную: brew install cliclick" : "Попробуйте вручную: sudo port install cliclick" }
}
