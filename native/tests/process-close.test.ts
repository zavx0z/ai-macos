import { expect, test } from "bun:test"
import { NativeProcessTransport } from "../src/adapter.ts"

test("owned child close эскалирует TERM и подтверждает exit", async () => {
  const transport = new NativeProcessTransport(process.execPath, ["-e", "process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)"])
  const pid = transport.processStatus.pid
  const started = performance.now()
  await Promise.all([transport.close(), transport.close()])
  expect(performance.now() - started).toBeLessThan(4000)
  expect(transport.processStatus.pid).toBe(pid)
  expect(transport.processStatus.exitConfirmed).toBe(true)
  expect(transport.processStatus.exitCode).not.toBeNull()
  await transport.close()
}, 5000)

test("уже завершившийся owned child не требует сигналов", async () => {
  const transport = new NativeProcessTransport(process.execPath, ["-e", "process.exit(0)"])
  await transport.close()
  expect(transport.processStatus.exitConfirmed).toBe(true)
  expect(transport.processStatus.exitCode).toBe(0)
})
