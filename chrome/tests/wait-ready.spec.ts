import { describe, expect, test } from "bun:test"
import type { CdpSession } from "@meta/shared"
import { assertCaptureDimensions, CdpCaptureLimitError, materializeConsoleArgument } from "../src/cdp-mode.ts"
import { armReadiness, waitOnSession } from "../src/wait-ready.ts"

type Handler = (params: unknown) => void

function fakeSession(evaluateValue: unknown = true): {
  session: CdpSession
  emit(method: string, params?: unknown): void
} {
  const subscriptions = new Map<string, Set<Handler>>()
  const session = {
    async send(method: string) {
      if (method === "Runtime.evaluate") return { result: { value: evaluateValue } }
      return {}
    },
    subscribe(method: string, handler: Handler) {
      let handlers = subscriptions.get(method)
      if (!handlers) {
        handlers = new Set()
        subscriptions.set(method, handlers)
      }
      handlers.add(handler)
      return () => handlers?.delete(handler)
    },
  } as unknown as CdpSession
  return {
    session,
    emit(method, params = {}) {
      for (const handler of subscriptions.get(method) ?? []) handler(params)
    },
  }
}

describe("strict browser readiness", () => {
  test("false predicate остаётся partial, а не success", async () => {
    const fake = fakeSession(false)
    const result = await waitOnSession(fake.session, {
      readyState: false,
      fonts: false,
      networkIdle: false,
      images: false,
      reflowStable: true,
      animations: false,
      finalCommit: false,
      stepMs: 100,
      maxMs: 500,
    })

    expect(result).toMatchObject({
      ok: false,
      status: "partial",
      incomplete: ["reflowStable"],
      timedOut: false,
    })
  })

  test("network tracker подписан до ACK Network.enable", async () => {
    const subscriptions = new Map<string, Set<Handler>>()
    let releaseEnable = () => {}
    const enabled = new Promise<void>((resolve) => { releaseEnable = resolve })
    const session = {
      async send(method: string) {
        if (method === "Network.enable") await enabled
        return {}
      },
      subscribe(method: string, handler: Handler) {
        let handlers = subscriptions.get(method)
        if (!handlers) {
          handlers = new Set()
          subscriptions.set(method, handlers)
        }
        handlers.add(handler)
        return () => handlers?.delete(handler)
      },
    } as unknown as CdpSession
    const emit = (method: string, params: unknown) => {
      for (const handler of subscriptions.get(method) ?? []) handler(params)
    }

    const trackerPromise = armReadiness(session, { networkIdle: true })
    emit("Network.requestWillBeSent", { requestId: "request-1" })
    releaseEnable()
    const tracker = await trackerPromise
    if (!tracker) throw new Error("Expected tracker")
    const controller = new AbortController()
    setTimeout(() => emit("Network.loadingFinished", { requestId: "request-1" }), 15)

    await expect(tracker.waitForNetworkIdle(10, 200, controller.signal)).resolves.toBeUndefined()
    tracker.close()
  })
})

describe("bounded browser capture", () => {
  test("отклоняет дорогой full-page clip до выделения изображения", () => {
    expect(() => assertCaptureDimensions(20_000, 2_000)).toThrow(CdpCaptureLimitError)
    expect(() => assertCaptureDimensions(8_000, 8_000)).toThrow(CdpCaptureLimitError)
    expect(() => assertCaptureDimensions(4_000, 4_000)).not.toThrow()
  })
})

test("console argument ограничивается до сборки entry", () => {
  const value = materializeConsoleArgument({ value: "😀".repeat(1_000) }, 101)
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(101)
  expect(value.length).toBeLessThan(2_000)
})
