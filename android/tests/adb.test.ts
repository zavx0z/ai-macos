import { describe, expect, test } from "bun:test"
import {
  AdbCommandCleanupError,
  AdbOutputLimitError,
  adbArgs,
  adbForwardList,
  parseAdbDevices,
  parseAdbForwardList,
  runAdbCommand,
  type AdbProcess,
} from "../src/adb.ts"

describe("ADB exact identity primitives", () => {
  test("каждая device-команда содержит serial", () => {
    expect(adbArgs("phone-a", "get-state")).toEqual(["adb", "-s", "phone-a", "get-state"])
    expect(() => adbArgs("", "get-state")).toThrow("serial is required")
  })

  test("парсит полный список устройств без выбора первого", () => {
    expect(parseAdbDevices("List of devices attached\nphone-a\tdevice\nphone-b\toffline\n\n")).toEqual([
      { serial: "phone-a", state: "device" },
      { serial: "phone-b", state: "offline" },
    ])
  })

  test("сохраняет владельца каждого forward", () => {
    expect(parseAdbForwardList(
      "phone-a tcp:9223 localabstract:chrome_devtools_remote\nphone-b tcp:9333 localabstract:other\n",
    )).toEqual([
      { serial: "phone-a", local: "tcp:9223", remote: "localabstract:chrome_devtools_remote" },
      { serial: "phone-b", local: "tcp:9333", remote: "localabstract:other" },
    ])
  })

  test("ошибка forward inventory не превращается в пустой список", async () => {
    await expect(adbForwardList(async () => ({
      stdout: "",
      stderr: "daemon unavailable",
      code: 1,
    }))).rejects.toThrow("adb forward --list failed: daemon unavailable")
  })

  test("already-aborted command отклоняется до spawn", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runAdbCommand(["command-that-must-not-spawn"], 100, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  test("never-exit и rejected-exit не считаются подтверждённой остановкой", async () => {
    for (const createExit of [
      () => new Promise<number>(() => {}),
      () => Promise.reject(new Error("exit unavailable")),
    ]) {
      const controller = new AbortController()
      const process = fakeProcess(createExit())
      const pending = runAdbCommand(["adb", "devices"], 1_000, controller.signal, () => process, 1)
      controller.abort()
      await expect(pending).rejects.toBeInstanceOf(AdbCommandCleanupError)
      expect(process.kills).toContain(9)
    }
  })

  test("late confirmed exit сохраняет исходный abort, не cleanup-unknown", async () => {
    let resolveExit = (_code: number) => {}
    const exited = new Promise<number>(resolve => { resolveExit = resolve })
    const process = fakeProcess(exited, () => resolveExit(143))
    const controller = new AbortController()
    const pending = runAdbCommand(["adb", "devices"], 1_000, controller.signal, () => process, 5)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("resolved exit с незакрытым stdout всё равно ограничен общим deadline", async () => {
    const process: AdbProcess = {
      stdout: new ReadableStream({ start() {} }),
      stderr: new ReadableStream({ start(controller) { controller.close() } }),
      exited: Promise.resolve(0),
      kill() {},
    }
    await expect(runAdbCommand(["adb", "devices"], 5, undefined, () => process, 1)).rejects.toThrow("timed out")
  })

  test("abort завершает whole read даже после resolved exit", async () => {
    const controller = new AbortController()
    const process: AdbProcess = {
      stdout: new ReadableStream({ start() {} }),
      stderr: new ReadableStream({ start(stream) { stream.close() } }),
      exited: Promise.resolve(0),
      kill() {},
    }
    const pending = runAdbCommand(["adb", "devices"], 1_000, controller.signal, () => process, 1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("ADB output ограничен до materialization", async () => {
    const process: AdbProcess = {
      stdout: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000)); controller.close() } }),
      stderr: new ReadableStream({ start(controller) { controller.close() } }),
      exited: Promise.resolve(0),
      kill() {},
    }
    await expect(runAdbCommand(["adb", "devices"], 100, undefined, () => process, 1, 1_024)).rejects.toBeInstanceOf(AdbOutputLimitError)
  })
})

function fakeProcess(exited: Promise<number>, onKill?: () => void): AdbProcess & { kills: Array<number | undefined> } {
  const kills: Array<number | undefined> = []
  return {
    stdout: new ReadableStream({ start(controller) { controller.close() } }),
    stderr: new ReadableStream({ start(controller) { controller.close() } }),
    exited,
    kills,
    kill(signal) {
      kills.push(signal)
      onKill?.()
    },
  }
}
