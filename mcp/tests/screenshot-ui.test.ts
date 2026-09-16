import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { screenshotUiHtml } from "../src/screenshot-ui.ts"

type UiEvent = {
  source?: unknown
  data?: unknown
  detail?: { globals: { toolResponseMetadata: unknown } }
}

function viewer() {
  const elements = new Map<string, {
    src?: string
    textContent?: string
    hidden?: boolean
    scrollHeight: number
    addEventListener(name: string, listener: () => void): void
    events: Map<string, () => void>
  }>()
  for (const id of ["viewer", "image", "caption", "details", "expand", "empty", "refresh"]) {
    const events = new Map<string, () => void>()
    elements.set(id, { scrollHeight: 100, events, addEventListener(name, listener) { events.set(name, listener) } })
  }
  const listeners = new Map<string, (event: UiEvent) => void>()
  const calls: Array<{ name: string, after: number }> = []
  const modes: string[] = []
  let resolveInitial!: (value: unknown) => void
  const initial = new Promise<unknown>(resolve => { resolveInitial = resolve })
  const parent = { postMessage() {} }
  const window = {
    parent,
    addEventListener(name: string, listener: (event: UiEvent) => void) { listeners.set(name, listener) },
    openai: {
      callTool(name: string, input: { after: number }) {
        calls.push({ name, after: input.after })
        return calls.length === 1 ? initial : Promise.resolve({})
      },
      async requestDisplayMode(input: { mode: string }) { modes.push(input.mode) },
      notifyIntrinsicHeight() {},
    },
  }
  const script = screenshotUiHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (script === undefined) throw new Error("Виджет не содержит script")
  runInNewContext(script, {
    window,
    document: {
      getElementById: (id: string) => elements.get(id),
      body: { scrollHeight: 100 },
      documentElement: { scrollHeight: 100 },
    },
    requestAnimationFrame(callback: () => void) { callback(); return 1 },
    cancelAnimationFrame() {},
    setInterval() { throw new Error("Периодический polling в PiP запрещён") },
    setTimeout() { throw new Error("Отложенный polling в PiP запрещён") },
  })
  return {
    elements, calls, modes, resolveInitial,
    result(value: unknown, trusted = true) {
      listeners.get("message")?.({ source: trusted ? parent : {},
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: value } })
    },
    globals(value: unknown) {
      listeners.get("openai:set_globals")?.({ detail: { globals: { toolResponseMetadata: value } } })
    },
  }
}

function frame(version: number, data: string) {
  return { structuredContent: { version, caption: `Кадр ${version}` },
    _meta: { screenshot: { mimeType: "image/png", data } } }
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve() }

test("PiP обновляет один image по событиям без периодического опроса", async () => {
  const ui = viewer()
  ui.resolveInitial(frame(1, "first"))
  await flush()
  const image = ui.elements.get("image")
  ui.result(frame(2, "second"))
  ui.result(frame(3, "third"))
  expect(ui.elements.get("image")).toBe(image)
  expect(image?.src).toBe("data:image/png;base64,third")
  expect(ui.calls).toEqual([{ name: "latest_capture", after: 0 }])
  expect(ui.modes).toEqual(["pip"])
  ui.elements.get("refresh")?.events.get("click")?.()
  await flush()
  expect(ui.calls[1]).toEqual({ name: "latest_capture", after: 3 })
})

test("запоздавший initial fetch не перезаписывает новый кадр PiP", async () => {
  const ui = viewer()
  ui.result(frame(2, "new"))
  ui.resolveInitial(frame(1, "old"))
  await flush()
  expect(ui.elements.get("image")?.src).toBe("data:image/png;base64,new")
  expect(ui.elements.get("caption")?.textContent).toBe("Кадр 2")
  ui.elements.get("refresh")?.events.get("click")?.()
  await flush()
  expect(ui.calls[1]?.after).toBe(2)
})

test("PiP принимает globals, но игнорирует сообщение не от родительского окна", async () => {
  const ui = viewer()
  ui.resolveInitial(frame(1, "first"))
  await flush()
  ui.result(frame(99, "foreign"), false)
  expect(ui.elements.get("image")?.src).toBe("data:image/png;base64,first")
  ui.globals(frame(2, "second"))
  await flush()
  expect(ui.elements.get("image")?.src).toBe("data:image/png;base64,second")
  expect(ui.modes).toEqual(["pip"])
})
