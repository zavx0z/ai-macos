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

export async function getPosition(): Promise<{ x: number; y: number }> {
  if (cliclickPath) {
    // cliclick p — prints "x,y"
    const { stdout } = await run([cliclickPath, "p"])
    const [x, y] = stdout.trim().split(",").map(Number)
    return { x: x ?? 0, y: y ?? 0 }
  }
  if (python3Path) {
    const py = "from Quartz import NSEvent; loc = NSEvent.mouseLocation(); print(f'{int(loc.x)},{int(loc.y)}')"
    const { stdout } = await run([python3Path, "-c", py])
    const [x, y] = stdout.trim().split(",").map(Number)
    return { x: x ?? 0, y: y ?? 0 }
  }
  throw new Error("getPosition requires cliclick or python3 (with Quartz)")
}

export async function move(x: number, y: number): Promise<{ via: "cliclick" | "python3" }> {
  if (cliclickPath) {
    const { stderr, code } = await run([cliclickPath, `m:${x},${y}`])
    if (code !== 0) throw new Error(`cliclick m: ${stderr.trim()}`)
    return { via: "cliclick" }
  }
  if (python3Path) {
    const py = `import Quartz; Quartz.CGWarpMouseCursorPosition((${x}, ${y}))`
    const { stderr, code } = await run([python3Path, "-c", py])
    if (code !== 0) throw new Error(`python3 Quartz: ${stderr.trim()}`)
    return { via: "python3" }
  }
  throw new Error("mouse move requires cliclick or python3")
}

export async function click(opts: {
  x?: number
  y?: number
  button?: MouseButton
  count?: number
}): Promise<{ via: "cliclick" | "applescript" }> {
  const { x, y } = opts
  const button = opts.button ?? "left"
  const count = opts.count ?? 1

  if (cliclickPath) {
    // cliclick verbs: c (click), rc (right click), dc (double click), tc (triple click)
    const target = x != null && y != null ? `${x},${y}` : "."
    const verb = button === "right" ? "rc" : count === 3 ? "tc" : count === 2 ? "dc" : "c"
    const { stderr, code } = await run([cliclickPath, `${verb}:${target}`])
    if (code !== 0) throw new Error(`cliclick ${verb}: ${stderr.trim()}`)
    return { via: "cliclick" }
  }

  // AppleScript fallback (System Events). Right-click is harder via AS.
  if (button === "left") {
    if (x != null && y != null) {
      // System Events click at — ограниченно, но работает в приложениях
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

  throw new Error(`button=${button} требует cliclick (brew/port install cliclick)`)
}

export async function drag(opts: {
  from: { x: number; y: number }
  to: { x: number; y: number }
  durationMs?: number
}): Promise<{ via: "cliclick" | "unsupported" }> {
  const { from, to } = opts
  if (cliclickPath) {
    // cliclick: dd (drag down) at start, dm (drag move) intermediate, du (drag up) end
    // Simplest: dd:x1,y1 du:x2,y2 — но это press at A, release at B (нет промежуточных точек).
    // Достаточно для большинства dnd-сценариев.
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
    // CGEvent scroll wheel — line-based scroll, dy положительное вверх в Quartz, инвертируем для UX
    const py = `
import Quartz
ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${-dy}, ${dx})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
`
    const { stderr, code } = await run([python3Path, "-c", py])
    if (code !== 0) throw new Error(`python3 scroll: ${stderr.trim()}`)
    return { via: "python3" }
  }

  // AppleScript fallback — посылаем PageDown / PageUp / стрелки. Не настоящий scroll, но рабочий.
  const repeats = Math.max(1, Math.abs(dy))
  if (dy < 0) {
    for (let i = 0; i < repeats; i++) await osa(`tell application "System Events" to key code 126`) // up
  } else if (dy > 0) {
    for (let i = 0; i < repeats; i++) await osa(`tell application "System Events" to key code 125`) // down
  }
  return { via: "applescript" }
}
