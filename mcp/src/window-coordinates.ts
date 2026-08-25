export type WindowBounds = Readonly<{
  app: string
  x: number
  y: number
  width: number
  height: number
}>

export type Point = Readonly<{x: number; y: number}>

/** Converts a top-left window-local logical point into macOS screen coordinates. */
export function windowLocalPointToScreen(target: WindowBounds, point: Point): Point {
  if (
    point.x < 0
    || point.y < 0
    || point.x >= target.width
    || point.y >= target.height
  ) {
    throw new Error(
      `Refusing click outside verified ${target.app} window-local bounds (0,0)–(${target.width},${target.height})`,
    )
  }
  return {x: target.x + point.x, y: target.y + point.y}
}
