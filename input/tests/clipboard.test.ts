import { describe, expect, spyOn, test } from "bun:test"
import { MAX_CLIPBOARD_TEXT_BYTES, readClipboardText, writeClipboardText, utf8ClipboardEnvironment } from "../src/clipboard.ts"

// Unit tests must not read or replace the user's general pasteboard.
const empty = () => new Blob([]).stream()
describe("clipboard encoding without system clipboard access", () => {
  test("overrides absent and non-UTF-8 parent locales only in child environment", () => {
    for (const base of [{}, { LANG: "C", LC_ALL: "C", LC_CTYPE: "ru_RU.KOI8-R", KEEP: "value" }]) {
      const child = utf8ClipboardEnvironment(base)
      expect([child.LANG, child.LC_ALL, child.LC_CTYPE]).toEqual(["en_US.UTF-8", "en_US.UTF-8", "en_US.UTF-8"])
      if ("KEEP" in base) { expect(child.KEEP).toBe("value"); expect(base.LANG).toBe("C") }
    }
  })
  test("writes exact multilingual text with UTF-8 locale", async () => {
    const text = "Новый арендатор — фасад\nДверь, € и 😀", chunks: string[] = []
    let command: string[] = [], locale: unknown[] = [], ended = false
    const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: any) => {
      command = cmd; locale = [options.env?.LANG, options.env?.LC_ALL, options.env?.LC_CTYPE]
      return { stdin: { write: (value: string) => chunks.push(value), end: () => { ended = true } }, stdout: empty(), stderr: empty(), exited: Promise.resolve(0) }
    }) as any)
    try {
      const result = await writeClipboardText(text)
      expect(command).toEqual(["/usr/bin/pbcopy"])
      expect(locale).toEqual(["en_US.UTF-8", "en_US.UTF-8", "en_US.UTF-8"])
      expect(chunks.join("")).toBe(text); expect(ended).toBe(true)
      expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"))
    } finally { spawn.mockRestore() }
  })
  test("decodes native output as UTF-8 with the same child locale", async () => {
    const text = "Кириллица, 日本語, 😀"
    let locale: unknown[] = [], command: string[] = []
    const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: any) => {
      command = cmd; locale = [options.env?.LANG, options.env?.LC_ALL, options.env?.LC_CTYPE]
      return { stdout: new Blob([text]).stream(), stderr: empty(), exited: Promise.resolve(0) }
    }) as any)
    try {
      expect((await readClipboardText()).text).toBe(text)
      expect(command).toEqual(["/usr/bin/pbpaste"])
      expect(locale).toEqual(["en_US.UTF-8", "en_US.UTF-8", "en_US.UTF-8"])
    } finally { spawn.mockRestore() }
  })
  test("rejects oversized UTF-8 before spawning a clipboard process", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => { throw new Error("must not spawn") }) as any)
    try {
      await expect(writeClipboardText("я".repeat(MAX_CLIPBOARD_TEXT_BYTES))).rejects.toThrow("clipboard text exceeds")
      expect(spawn).toHaveBeenCalledTimes(0)
    } finally { spawn.mockRestore() }
  })
})
