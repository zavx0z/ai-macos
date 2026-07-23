import { nativeCommand } from "./native.ts"
import { KEY_CODES, modifierFlags, parseShortcut } from "./keys.ts"

let helperPath: string | null = null

export function setKeyboardNativeHelper(path: string | null): void {
  helperPath = path
}

function helper(): string {
  if (!helperPath) throw new Error("meta-input-helper недоступен")
  return helperPath
}

export async function typeText(text: string, delayMs = 0): Promise<void> {
  await nativeCommand(helper(), ["type", text, String(delayMs)])
}

export async function pressKey(key: string, modifiers: string[] = []): Promise<void> {
  const lower = key.toLowerCase()
  const code = KEY_CODES[lower]
  if (code !== undefined) {
    let flags = modifierFlags(modifiers)
    if (key.length === 1 && key !== lower) flags |= 0x0002_0000
    await nativeCommand(helper(), ["key", String(code), String(flags)])
    return
  }
  if (key.length === 1 && modifiers.length === 0) {
    await typeText(key)
    return
  }
  throw new Error(
    `unknown key: '${key}'. Допустимы: ${Object.keys(KEY_CODES).slice(0, 10).join(", ")}, ... или одиночный символ без модификаторов`,
  )
}

export async function pressShortcut(shortcut: string): Promise<void> {
  const { key, modifiers } = parseShortcut(shortcut)
  await pressKey(key, modifiers)
}

export async function pressShortcuts(shortcuts: string[], delayMs = 0): Promise<void> {
  for (let i = 0; i < shortcuts.length; i++) {
    await pressShortcut(shortcuts[i]!)
    if (delayMs > 0 && i < shortcuts.length - 1) await Bun.sleep(delayMs)
  }
}
