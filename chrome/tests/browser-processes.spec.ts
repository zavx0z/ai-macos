import {describe, expect, test} from "bun:test"
import {
  ChromeProcessAmbiguityError,
  assertUnambiguousChromeProcesses,
  parseChromeBrowserProcesses,
} from "../src/browser-processes.ts"

describe("Google Chrome process inventory", () => {
  test("distinguishes the default profile from the separate CDP profile", () => {
    const processes = parseChromeBrowserProcesses(`
  564 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
96181 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/Users/test/Library/Application Support/Google/Chrome-CDP --no-first-run
96190 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process
`)

    expect(processes).toEqual([
      {pid: 564, profile: "default", remoteDebugging: false, userDataDir: null},
      {
        pid: 96181,
        profile: "cdp",
        remoteDebugging: true,
        userDataDir: "/Users/test/Library/Application Support/Google/Chrome-CDP",
      },
    ])
  })

  test("the ambiguity error never presents one profile inventory as complete", () => {
    const processes = parseChromeBrowserProcesses(`
1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
2 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp
`)
    expect(() => assertUnambiguousChromeProcesses(processes)).toThrow(ChromeProcessAmbiguityError)
    let error: ChromeProcessAmbiguityError | null = null
    try {
      assertUnambiguousChromeProcesses(processes)
    } catch (caught) {
      error = caught as ChromeProcessAmbiguityError
    }
    expect(error).toBeInstanceOf(ChromeProcessAmbiguityError)
    if (!error) throw new Error("Expected ChromeProcessAmbiguityError")
    expect(error.status).toBe(409)
    expect(error.message).toContain("pid 1 (default)")
    expect(error.message).toContain("pid 2 (cdp)")
    expect(error.message).toContain("GET /cdp/targets")
  })
})
