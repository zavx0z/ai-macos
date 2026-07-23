import { nativeCommand } from "./native.ts"

export type MouseButton = "left" | "right" | "middle"

let helperPath: string | null = null

export function setNativeHelper(path: string | null): void {
  helperPath = path
}

function helper(): string {
  if (!helperPath) throw new Error("meta-input-helper недоступен")
  return helperPath
}

export async function getPosition(): Promise<{ x: number; y: number }> {
  const output = await nativeCommand(helper(), ["position"])
  const [x, y] = output.split(",").map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`некорректная позиция курсора: ${output}`)
  }
  return { x: x!, y: y! }
}

export async function move(
  x: number,
  y: number,
): Promise<{ via: "native-helper" }> {
  await nativeCommand(helper(), ["move", String(x), String(y)])
  return { via: "native-helper" }
}

export async function click(opts: {
  x?: number
  y?: number
  button?: MouseButton
  count?: number
}): Promise<{ via: "native-helper" }> {
  const position =
    opts.x == null || opts.y == null ? await getPosition() : { x: opts.x, y: opts.y }
  const button = opts.button ?? "left"
  const buttonCode = button === "right" ? 1 : button === "middle" ? 2 : 0
  await nativeCommand(helper(), [
    "click",
    String(position.x),
    String(position.y),
    String(buttonCode),
    String(opts.count ?? 1),
  ])
  return { via: "native-helper" }
}

export async function drag(opts: {
  from: { x: number; y: number }
  to: { x: number; y: number }
  durationMs?: number
}): Promise<{ via: "native-helper" }> {
  await nativeCommand(helper(), [
    "drag",
    String(opts.from.x),
    String(opts.from.y),
    String(opts.to.x),
    String(opts.to.y),
    String(opts.durationMs ?? 100),
  ])
  return { via: "native-helper" }
}

export async function scroll(opts: {
  dx?: number
  dy?: number
}): Promise<{ via: "native-helper" }> {
  await nativeCommand(helper(), [
    "scroll",
    String(opts.dx ?? 0),
    String(opts.dy ?? 0),
  ])
  return { via: "native-helper" }
}
