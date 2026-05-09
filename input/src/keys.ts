// macOS virtual key codes (Carbon)
// Reference: https://eastmanreference.com/complete-list-of-applescript-key-codes
export const KEY_CODES: Record<string, number> = {
  // Letters (без shift даёт строчные)
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
  k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17,
  u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,

  // Numbers (top row)
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,

  // Special
  enter: 36, return: 36,
  tab: 48,
  space: 49,
  delete: 51, backspace: 51,
  forwarddelete: 117, "delete-forward": 117,
  escape: 53, esc: 53,
  capslock: 57,

  // Modifier keys (как самостоятельные клавиши, не модификаторы)
  shift: 56, "shift-right": 60,
  control: 59, "control-right": 62, ctrl: 59,
  option: 58, "option-right": 61, alt: 58, opt: 58,
  command: 55, "command-right": 54, cmd: 55, meta: 55,
  fn: 63, function: 63,

  // Arrows
  left: 123, right: 124, down: 125, up: 126,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,

  // Navigation
  home: 115, end: 119,
  pageup: 116, pagedown: 121,

  // Function keys
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,

  // Punctuation (без shift)
  "-": 27, "=": 24,
  "[": 33, "]": 30, "\\": 42,
  ";": 41, "'": 39,
  ",": 43, ".": 47, "/": 44,
  "`": 50,

  // Numpad
  "num0": 82, "num1": 83, "num2": 84, "num3": 85, "num4": 86,
  "num5": 87, "num6": 88, "num7": 89, "num8": 91, "num9": 92,
  "numdot": 65, "numplus": 69, "numminus": 78, "numstar": 67, "numslash": 75, "numequals": 81,
  "numenter": 76, "numclear": 71,
}

export const MODIFIERS: Record<string, string> = {
  cmd: "command down", command: "command down", meta: "command down", "⌘": "command down",
  shift: "shift down", "⇧": "shift down",
  alt: "option down", option: "option down", opt: "option down", "⌥": "option down",
  ctrl: "control down", control: "control down", "⌃": "control down",
  fn: "function down",
}

export type ParsedShortcut = {
  key: string
  modifiers: string[]
}

/**
 * Parse "cmd+shift+t" → { key: "t", modifiers: ["cmd", "shift"] }
 * Last token is the key, all preceding are modifiers.
 */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+").map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) throw new Error("empty shortcut")
  const key = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1)
  return { key, modifiers }
}

export function modifiersUsing(modifiers: string[]): string {
  const mapped = modifiers
    .map((m) => MODIFIERS[m.toLowerCase()])
    .filter((m): m is string => Boolean(m))
  if (mapped.length === 0) return ""
  return ` using {${mapped.join(", ")}}`
}
