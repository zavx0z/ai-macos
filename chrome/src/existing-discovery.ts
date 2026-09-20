import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"

export type ExistingChromeEndpoint = { userDataDir: string; port: number; browserPath: string; webSocketUrl: string }
const MAX_DISCOVERY_BYTES = 1_024

export function defaultChromeUserDataDir(): string {
  if (process.platform !== "darwin") throw new Error("Default Chrome discovery is supported on macOS only; specify userDataDir")
  return join(homedir(), "Library", "Application Support", "Google", "Chrome")
}

export function parseDevToolsActivePort(text: string, userDataDir: string): ExistingChromeEndpoint {
  if (Buffer.byteLength(text) > MAX_DISCOVERY_BYTES) throw new Error("CHROME_DISCOVERY_INVALID: file is too large")
  const lines = text.trim().split(/\r?\n/).map(line => line.trim())
  const rawPort = lines[0] ?? ""
  const browserPath = lines[1] ?? ""
  const port = Number(rawPort)
  if (lines.length !== 2 || !/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535
    || !/^\/devtools\/browser(?:\/[A-Za-z0-9_-]+)?\/?$/.test(browserPath) || browserPath.length > 512) {
    throw new Error("CHROME_DISCOVERY_INVALID: expected a local port and browser WebSocket path")
  }
  return { userDataDir, port, browserPath, webSocketUrl: `ws://127.0.0.1:${port}${browserPath}` }
}

/** Reads only Chrome's published endpoint file. Does not launch, configure, or modify Chrome. */
export async function discoverExistingChrome(userDataDir: string): Promise<ExistingChromeEndpoint> {
  if (!isAbsolute(userDataDir)) throw new Error("Chrome userDataDir must be an absolute path")
  let canonical: string
  try { canonical = await realpath(userDataDir) } catch {
    throw new Error("CHROME_DISCOVERY_UNAVAILABLE: selected Chrome user data directory is unavailable")
  }
  // Runtime's durable ownership key is this directory, not an ephemeral port.
  // Reject symlink aliases rather than silently creating two owners for the same browser.
  const configured = normalize(userDataDir).replace(/\/$/, "") || "/"
  if (canonical !== configured) throw new Error("CHROME_DISCOVERY_NONCANONICAL: configure the canonical userDataDir, not a symlink alias")
  const path = join(canonical, "DevToolsActivePort")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error("CHROME_DISCOVERY_UNAVAILABLE: enable remote debugging in the selected running Chrome at chrome://inspect/#remote-debugging; no browser was launched")
  })
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_DISCOVERY_BYTES || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("CHROME_DISCOVERY_INVALID: expected a bounded regular file owned by the current user")
    }
    const buffer = Buffer.alloc(MAX_DISCOVERY_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_DISCOVERY_BYTES) throw new Error("CHROME_DISCOVERY_INVALID: file changed beyond the size limit")
    return parseDevToolsActivePort(buffer.subarray(0, bytesRead).toString("utf8"), canonical)
  } finally { await file.close() }
}
