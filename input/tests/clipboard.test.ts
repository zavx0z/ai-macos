import { describe, expect, test } from "bun:test"
import {
  clipboardHealth,
  readClipboardText,
  writeClipboardText,
} from "../src/clipboard.ts"

describe("system clipboard", () => {
  test("uses native macOS pbpaste/pbcopy and round-trips UTF-8 text", async () => {
    const health = await clipboardHealth()
    expect(health).toMatchObject({ ok: true, backend: "pbpaste/pbcopy" })

    const original = await readClipboardText()
    const marker = `ai-macos-clipboard-${crypto.randomUUID()}-Привет`
    try {
      const written = await writeClipboardText(marker)
      expect(written.length).toBe(marker.length)
      expect((await readClipboardText()).text).toBe(marker)
    } finally {
      await writeClipboardText(original.text)
    }
  })
})
