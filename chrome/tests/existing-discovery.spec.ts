import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverExistingChrome, parseDevToolsActivePort } from "../src/existing-discovery.ts"

async function temporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chrome-attach-discovery-")))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

describe("existing Chrome endpoint discovery", () => {
  test("accepts the approval browser path with or without an identifier", () => {
    expect(parseDevToolsActivePort("43123\n/devtools/browser\n", "/fixture").webSocketUrl).toBe("ws://127.0.0.1:43123/devtools/browser")
    expect(parseDevToolsActivePort("43123\r\n/devtools/browser/abc-123\r\n", "/fixture").webSocketUrl).toBe("ws://127.0.0.1:43123/devtools/browser/abc-123")
  })

  test("rejects malformed ports, non-browser paths and endpoint injection", () => {
    for (const value of [
      "0\n/devtools/browser", "65536\n/devtools/browser", "1.1\n/devtools/browser",
      "1e3\n/devtools/browser", "9222\nws://example.test/devtools/browser",
      "9222\n/devtools/page/a", "9222\n/devtools/browser/../../x",
      "9222\n/devtools/browser?token=x", "9222\n/devtools/browser\nextra",
      "9222\n/devtools/browser/" + "x".repeat(1_025),
    ]) expect(() => parseDevToolsActivePort(value, "/fixture")).toThrow("CHROME_DISCOVERY_INVALID")
  })

  test("reads a bounded regular endpoint file without changing it", async () => {
    await temporaryDirectory(async directory => {
      const path = join(directory, "DevToolsActivePort")
      const content = "43123\n/devtools/browser/test\n"
      await writeFile(path, content)
      const endpoint = await discoverExistingChrome(directory)
      expect(endpoint).toEqual({ userDataDir: directory, port: 43123, browserPath: "/devtools/browser/test", webSocketUrl: "ws://127.0.0.1:43123/devtools/browser/test" })
      expect(await readFile(path, "utf8")).toBe(content)
      expect(await readdir(directory)).toEqual(["DevToolsActivePort"])
    })
  })

  test("missing endpoint remains missing; discovery does not create a profile or file", async () => {
    await temporaryDirectory(async directory => {
      await expect(discoverExistingChrome(directory)).rejects.toThrow("CHROME_DISCOVERY_UNAVAILABLE")
      expect(await readdir(directory)).toEqual([])
    })
    await expect(discoverExistingChrome("relative/path")).rejects.toThrow("absolute path")
  })

  test("rejects a symlink endpoint file", async () => {
    await temporaryDirectory(async directory => {
      await writeFile(join(directory, "published"), "43123\n/devtools/browser/test\n")
      await symlink(join(directory, "published"), join(directory, "DevToolsActivePort"))
      await expect(discoverExistingChrome(directory)).rejects.toThrow("CHROME_DISCOVERY_UNAVAILABLE")
    })
  })

  test("rejects a userDataDir symlink alias so lifetime ownership cannot silently split", async () => {
    await temporaryDirectory(async directory => {
      await writeFile(join(directory, "DevToolsActivePort"), "43123\n/devtools/browser/test\n")
      const alias = join(directory, "alias")
      await symlink(directory, alias)
      await expect(discoverExistingChrome(alias)).rejects.toThrow("CHROME_DISCOVERY_NONCANONICAL")
    })
  })

  test("rejects oversized discovery before parsing", async () => {
    await temporaryDirectory(async directory => {
      await writeFile(join(directory, "DevToolsActivePort"), "x".repeat(1_025))
      await expect(discoverExistingChrome(directory)).rejects.toThrow("CHROME_DISCOVERY_INVALID")
    })
  })
})
