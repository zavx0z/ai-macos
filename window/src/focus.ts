import { validWindowId } from "@meta/shared"
export interface WindowFrame {
  pid: number
  index: number
  windowId?: number
  ownerWindowId?: number
  x: number
  y: number
  width: number
  height: number
}

export function isFocusedSheet(target: WindowFrame, focused: WindowFrame): boolean {
  if (focused.pid !== target.pid) return false
  if (validWindowId(target.windowId)) {
    return focused.ownerWindowId === target.windowId
  }
  if (focused.index !== 0) return false
  if (focused.width <= 0 || focused.height <= 0) return false

  return focused.x >= target.x
    && focused.y >= target.y
    && focused.x + focused.width <= target.x + target.width
    && focused.y + focused.height <= target.y + target.height
}
