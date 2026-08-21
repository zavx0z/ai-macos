import { access, constants } from "node:fs/promises"

const PBPASTE = "/usr/bin/pbpaste"
const PBCOPY = "/usr/bin/pbcopy"

export const MAX_CLIPBOARD_TEXT_BYTES = 1_000_000

export type ClipboardHealth = {
  ok: boolean
  backend: "pbpaste/pbcopy"
  readPath: string
  writePath: string
  error?: string
}

export async function clipboardHealth(): Promise<ClipboardHealth> {
  try {
    await Promise.all([
      access(PBPASTE, constants.X_OK),
      access(PBCOPY, constants.X_OK),
    ])
    return {
      ok: true,
      backend: "pbpaste/pbcopy",
      readPath: PBPASTE,
      writePath: PBCOPY,
    }
  } catch (error) {
    return {
      ok: false,
      backend: "pbpaste/pbcopy",
      readPath: PBPASTE,
      writePath: PBCOPY,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function readClipboardText(): Promise<{ text: string; length: number; bytes: number }> {
  const process = Bun.spawn([PBPASTE], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [text, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `pbpaste exited with code ${exitCode}`)
  }
  return {
    text,
    length: text.length,
    bytes: new TextEncoder().encode(text).byteLength,
  }
}

export async function writeClipboardText(text: string): Promise<{ length: number; bytes: number }> {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > MAX_CLIPBOARD_TEXT_BYTES) {
    throw new Error(`clipboard text exceeds ${MAX_CLIPBOARD_TEXT_BYTES} bytes`)
  }

  const process = Bun.spawn([PBCOPY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  process.stdin.write(text)
  process.stdin.end()
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `pbcopy exited with code ${exitCode}`)
  }
  return { length: text.length, bytes }
}
