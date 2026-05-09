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

/** Активная проверка Accessibility — экспортирована для re-probe из /permissions/accessibility */
export async function probeAccessibilityNow(tool: string): Promise<boolean> {
  return await probeAccessibility(tool)
}

const PY_PROBE = `
import ctypes, time
CG=ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
class P(ctypes.Structure):_fields_=[('x',ctypes.c_double),('y',ctypes.c_double)]
CG.CGEventCreate.restype=ctypes.c_void_p
CG.CGEventCreate.argtypes=[ctypes.c_void_p]
CG.CGEventGetLocation.restype=P
CG.CGEventGetLocation.argtypes=[ctypes.c_void_p]
CG.CGEventCreateMouseEvent.restype=ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint32,P,ctypes.c_uint32]
CG.CGEventPost.argtypes=[ctypes.c_uint32,ctypes.c_void_p]
CG.CFRelease.argtypes=[ctypes.c_void_p]
def pos():
  e=CG.CGEventCreate(None);loc=CG.CGEventGetLocation(e);CG.CFRelease(e);return int(loc.x),int(loc.y)
bx,by=pos()
e=CG.CGEventCreateMouseEvent(None,5,P(bx+1,by),0)
CG.CGEventPost(0,e);CG.CFRelease(e)
time.sleep(0.1)
ax,ay=pos()
e=CG.CGEventCreateMouseEvent(None,5,P(bx,by),0)
CG.CGEventPost(0,e);CG.CFRelease(e)
exit(0 if ax==bx+1 else 1)
`.trim()

async function probeAccessibility(python3: string): Promise<boolean> {
  try {
    const proc = spawn([python3, "-c", PY_PROBE], { stdout: "pipe", stderr: "pipe" })
    return (await proc.exited) === 0
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

async function pythonWorks(pythonPath: string): Promise<boolean> {
  try {
    const proc = spawn([pythonPath, "-c", "import ctypes; ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')"], { stdout: "pipe", stderr: "pipe" })
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


export async function bootstrap(autoInstall = true): Promise<InputBootstrapStatus> {
  console.log()
  console.log(`  ${C}@meta/input bootstrap${RESET}`)

  const cliclick = await which("cliclick")
  if (cliclick) console.log(`  ${OK} cliclick (${cliclick})`)

  const pythonRaw = await which("python3")
  let python3: string | null = null
  if (pythonRaw && (await pythonWorks(pythonRaw))) {
    python3 = pythonRaw
    console.log(`  ${OK} python3+ctypes (${python3})`)
  }

  const pm = await detectPackageManager()

  if (python3) {
    const acc = await probeAccessibility(python3)
    if (acc) {
      console.log(`  ${OK} Accessibility разрешён`)
      console.log()
      return { cliclick, python3, packageManager: pm, accessibility: true }
    }
  }

  console.log(`  ${WARN} Accessibility не выдан процессу bun/терминалу`)
  console.log(`  ${D}↳ Откройте: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'${RESET}`)
  console.log(`  ${D}  Добавьте: ваш терминал (iTerm/Terminal) или сам бинарник bun${RESET}`)
  console.log()
  return { cliclick, python3, packageManager: pm, accessibility: false,
    hint: "Выдайте Accessibility терминалу/bun: System Settings → Privacy → Accessibility (или GET http://localhost:7882/permissions/accessibility)" }
}
