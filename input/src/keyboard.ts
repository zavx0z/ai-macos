import { osa, quote } from "@meta/shared"
import { KEY_CODES, modifiersUsing, parseShortcut } from "./keys.ts"

export async function typeText(text: string, delayMs = 0): Promise<void> {
  if (delayMs > 0) {
    for (const ch of text) {
      await osa(`tell application "System Events" to keystroke ${quote(ch)}`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
    return
  }
  await osa(`tell application "System Events" to keystroke ${quote(text)}`)
}

/** Press a single key by name, optionally with modifiers. */
export async function pressKey(key: string, modifiers: string[] = []): Promise<void> {
  const using = modifiersUsing(modifiers)
  const lower = key.toLowerCase()
  const code = KEY_CODES[lower]
  if (code !== undefined) {
    await osa(`tell application "System Events" to key code ${code}${using}`)
    return
  }
  if (key.length === 1) {
    // single printable char — keystroke это и применит модификаторы корректно
    await osa(`tell application "System Events" to keystroke ${quote(key)}${using}`)
    return
  }
  throw new Error(`unknown key: '${key}'. Допустимы: ${Object.keys(KEY_CODES).slice(0, 10).join(", ")}, ... или одиночный символ`)
}

/** Press a chord like "cmd+shift+t". */
export async function pressShortcut(shortcut: string): Promise<void> {
  const { key, modifiers } = parseShortcut(shortcut)
  await pressKey(key, modifiers)
}

/** Press a sequence of shortcuts. */
export async function pressShortcuts(shortcuts: string[], delayMs = 0): Promise<void> {
  for (let i = 0; i < shortcuts.length; i++) {
    await pressShortcut(shortcuts[i]!)
    if (delayMs > 0 && i < shortcuts.length - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
}
