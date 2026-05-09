import { spawn } from "bun"
import { osa } from "@meta/shared"

export type MouseButton = "left" | "right" | "middle"

let cliclickPath: string | null = null
let python3Path: string | null = null

export function setTools(opts: { cliclick: string | null; python3: string | null }): void {
  cliclickPath = opts.cliclick
  python3Path = opts.python3
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

async function py(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!python3Path) throw new Error("python3 недоступен")
  return run([python3Path, "-c", script])
}

const PY_CG_HEADER = `
import ctypes,time
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
CG.CGEventCreateScrollWheelEvent.restype=ctypes.c_void_p
CG.CGEventCreateScrollWheelEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_int32,ctypes.c_int32]
def post(t,x,y,btn=0):
  e=CG.CGEventCreateMouseEvent(None,t,P(x,y),btn);CG.CGEventPost(0,e);CG.CFRelease(e)
`.trimStart()

export async function getPosition(): Promise<{ x: number; y: number }> {
  if (python3Path) {
    const script = PY_CG_HEADER + `
e=CG.CGEventCreate(None);loc=CG.CGEventGetLocation(e);CG.CFRelease(e)
print(f'{int(loc.x)},{int(loc.y)}')
`
    const { stdout } = await py(script)
    const [x, y] = stdout.trim().split(",").map(Number)
    return { x: x ?? 0, y: y ?? 0 }
  }
  if (cliclickPath) {
    const { stdout } = await run([cliclickPath, "p"])
    const [x, y] = stdout.trim().split(",").map(Number)
    return { x: x ?? 0, y: y ?? 0 }
  }
  throw new Error("getPosition требует python3 или cliclick")
}

export async function move(x: number, y: number): Promise<{ via: "cliclick" | "python3" }> {
  if (python3Path) {
    // kCGEventMouseMoved=5
    const script = PY_CG_HEADER + `post(5,${x},${y})`
    const { stderr, code } = await py(script)
    if (code !== 0) throw new Error(`python3 move: ${stderr.trim()}`)
    return { via: "python3" }
  }
  if (cliclickPath) {
    const { stderr, code } = await run([cliclickPath, `m:${x},${y}`])
    if (code !== 0) throw new Error(`cliclick m: ${stderr.trim()}`)
    return { via: "cliclick" }
  }
  throw new Error("mouse move требует python3 или cliclick")
}

export async function click(opts: {
  x?: number
  y?: number
  button?: MouseButton
  count?: number
}): Promise<{ via: "cliclick" | "applescript" | "python3" }> {
  const { x, y } = opts
  const button = opts.button ?? "left"
  const count = opts.count ?? 1

  if (python3Path) {
    // kCGEventLeftMouseDown=1, kCGEventLeftMouseUp=2
    // kCGEventRightMouseDown=3, kCGEventRightMouseUp=4
    // kCGEventOtherMouseDown=25, kCGEventOtherMouseUp=26
    const cx = x ?? 0
    const cy = y ?? 0
    const needMove = x != null && y != null
    let [down, up, btn] =
      button === "right" ? [3, 4, 1] :
      button === "middle" ? [25, 26, 2] :
      [1, 2, 0]
    const moveAndPos = needMove
      ? `post(5,${cx},${cy})\ntime.sleep(0.02)\n`
      : `e=CG.CGEventCreate(None);loc=CG.CGEventGetLocation(e);CG.CFRelease(e)\ncx,cy=int(loc.x),int(loc.y)\n`
    const posArgs = needMove ? `${cx},${cy},${btn}` : `cx,cy,${btn}`
    let body = PY_CG_HEADER
    if (needMove) body += `post(5,${cx},${cy})\ntime.sleep(0.02)\n`
    else body += `e=CG.CGEventCreate(None);loc=CG.CGEventGetLocation(e);CG.CFRelease(e)\ncx,cy=int(loc.x),int(loc.y)\n`
    for (let i = 0; i < count; i++) {
      const px = needMove ? `${cx}` : "cx"
      const py2 = needMove ? `${cy}` : "cy"
      body += `post(${down},${needMove ? cx : "cx"},${needMove ? cy : "cy"},${btn})\ntime.sleep(0.05)\npost(${up},${needMove ? cx : "cx"},${needMove ? cy : "cy"},${btn})\n`
      if (i < count - 1) body += `time.sleep(0.05)\n`
    }
    const { stderr, code } = await py(body)
    if (code !== 0) throw new Error(`python3 click: ${stderr.trim()}`)
    return { via: "python3" }
  }

  if (cliclickPath) {
    const target = x != null && y != null ? `${x},${y}` : "."
    const verb = button === "right" ? "rc" : count === 3 ? "tc" : count === 2 ? "dc" : "c"
    const { stderr, code } = await run([cliclickPath, `${verb}:${target}`])
    if (code !== 0) throw new Error(`cliclick ${verb}: ${stderr.trim()}`)
    return { via: "cliclick" }
  }

  if (button === "left") {
    if (x != null && y != null) {
      for (let i = 0; i < count; i++) {
        await osa(`tell application "System Events" to click at {${x}, ${y}}`)
        if (i < count - 1) await new Promise((r) => setTimeout(r, 50))
      }
      return { via: "applescript" }
    }
    for (let i = 0; i < count; i++) {
      await osa(`tell application "System Events" to click`)
      if (i < count - 1) await new Promise((r) => setTimeout(r, 50))
    }
    return { via: "applescript" }
  }

  throw new Error(`button=${button} требует cliclick или python3`)
}

export async function drag(opts: {
  from: { x: number; y: number }
  to: { x: number; y: number }
  durationMs?: number
}): Promise<{ via: "cliclick" | "python3" | "unsupported" }> {
  const { from, to } = opts
  if (python3Path) {
    // kCGEventLeftMouseDown=1, kCGEventLeftMouseDragged=6, kCGEventLeftMouseUp=2
    const delay = opts.durationMs ? opts.durationMs / 1000 : 0.1
    const script = PY_CG_HEADER +
      `post(1,${from.x},${from.y})\ntime.sleep(0.05)\npost(6,${to.x},${to.y})\ntime.sleep(${delay})\npost(2,${to.x},${to.y})\n`
    const { stderr, code } = await py(script)
    if (code !== 0) throw new Error(`python3 drag: ${stderr.trim()}`)
    return { via: "python3" }
  }
  if (cliclickPath) {
    const cmds: string[] = [`dd:${from.x},${from.y}`]
    if (opts.durationMs && opts.durationMs > 0) cmds.push(`w:${Math.min(opts.durationMs, 5000)}`)
    cmds.push(`du:${to.x},${to.y}`)
    const { stderr, code } = await run([cliclickPath, ...cmds])
    if (code !== 0) throw new Error(`cliclick drag: ${stderr.trim()}`)
    return { via: "cliclick" }
  }
  return { via: "unsupported" }
}

export async function scroll(opts: { dx?: number; dy?: number }): Promise<{ via: "applescript" | "python3" }> {
  const dx = opts.dx ?? 0
  const dy = opts.dy ?? 0

  if (python3Path) {
    // kCGScrollEventUnitLine=1, dy>0 вниз для UX — инвертируем для Quartz
    const script = PY_CG_HEADER +
      `e=CG.CGEventCreateScrollWheelEvent(None,1,2,${-dy},${dx})\nCG.CGEventPost(0,e)\nCG.CFRelease(e)\n`
    const { stderr, code } = await py(script)
    if (code !== 0) throw new Error(`python3 scroll: ${stderr.trim()}`)
    return { via: "python3" }
  }

  const repeats = Math.max(1, Math.abs(dy))
  if (dy < 0) {
    for (let i = 0; i < repeats; i++) await osa(`tell application "System Events" to key code 126`)
  } else if (dy > 0) {
    for (let i = 0; i < repeats; i++) await osa(`tell application "System Events" to key code 125`)
  }
  return { via: "applescript" }
}
