import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { viewerUiHtml } from "../src/viewer-ui.ts"

test("сборка сохраняет русские подписи HTML без буквальных Unicode escape", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("../src/viewer-ui.ts", import.meta.url).pathname], target: "bun" })
  expect(bundle.success).toBe(true)
  const module = await import(`data:text/javascript;base64,${Buffer.from(await bundle.outputs[0]!.text()).toString("base64")}`)
  expect(module.viewerUiHtml).toContain("<h1>Codex App</h1>")
  expect(module.viewerUiHtml).toContain("На весь экран")
  expect(module.viewerUiHtml).not.toContain(String.raw`\u0417`)
})

test("один интерфейс принимает два сервиса; fullscreen только по кнопке и подтверждению хоста", async () => {
  const elements = new Map<string, any>()
  for (const id of ["status", "source", "text", "image", "figure", "caption", "fullscreen", "pip", "inline", "resume"]) {
    elements.set(id, { textContent: "", hidden: false, events: new Map(),
      addEventListener(name: string, handler: () => void) { this.events.set(name, handler) } })
  }
  const events = new Map<string, (event?: any) => void>()
  const requests: Array<{ args: any, resolve(value: unknown): void, reject(error: Error): void }> = []
  const modes: string[] = []
  let granted = "inline"
  const window = { parent: { postMessage() {} },
    addEventListener(name: string, handler: (event: unknown) => void) { events.set(name, handler) },
    openai: {
      toolResponseMetadata: { mcp_tool_result: { _meta: { viewer: { viewerId: "viewer", accessToken: "token", version: 0 } } } },
      callTool(_name: string, args: unknown) {
        return new Promise((resolve, reject) => requests.push({ args, resolve, reject }))
      },
      async requestDisplayMode(input: { mode: string }) { modes.push(input.mode)
        return { mode: granted } },
    },
  }
  const script = viewerUiHtml.match(/<script>([\s\S]*?)<\/script>/)![1]!
  runInNewContext(script, { window, document: { body: { dataset: {} }, getElementById: (id: string) => elements.get(id) },
    crypto: { randomUUID: () => "same-mount" }, setTimeout, clearTimeout,
    setInterval() { throw new Error("Секундный polling запрещён") } })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  await flush()
  expect(requests).toHaveLength(1)
  expect(modes).toEqual([])
  const text = elements.get("text")
  requests[0]!.resolve({ result: '{"version":1,"changed":true}', structuredContent: { version: 1, changed: true },
    _meta: { viewer: { version: 1, changed: true, content: { kind: "text", service: "demo-a", text: "A" } } } })
  await flush()
  expect(text.textContent).toBe("A")
  expect(requests[1]!.args).toMatchObject({ after: 1, mountId: "same-mount", displayedVersion: 1 })
  requests[1]!.resolve({ result: '{"version":2,"changed":true}', structuredContent: { version: 2, changed: true },
    meta: { viewer: { version: 2, changed: true, content: { kind: "text", service: "demo-b", text: "B" } } } })
  await flush()
  expect(elements.get("text")).toBe(text)
  expect(text.textContent).toBe("B")
  expect(elements.get("source").textContent).toBe("demo-b")
  await elements.get("fullscreen").events.get("click")()
  expect(elements.get("status").textContent).toContain("inline")
  granted = "fullscreen"
  await elements.get("fullscreen").events.get("click")()
  expect(elements.get("status").textContent).toBe("Режим: fullscreen")
  granted = "pip"
  await elements.get("pip").events.get("click")()
  expect(elements.get("status").textContent).toBe("Режим: pip")
  granted = "inline"
  await elements.get("inline").events.get("click")()
  expect(elements.get("status").textContent).toBe("Режим: inline")
  expect(modes).toEqual(["fullscreen", "fullscreen", "pip", "inline"])
  requests[2]!.reject(new Error("Связь прервана"))
  await flush()
  expect(requests).toHaveLength(3)
  expect(elements.get("resume").hidden).toBe(false)
  expect(elements.get("status").textContent).toBe("Связь прервана")
  elements.get("resume").events.get("click")()
  requests[3]!.resolve({ structuredContent: { version: 3, changed: true } })
  await flush()
  expect(requests).toHaveLength(4)
  expect(elements.get("status").textContent).toContain("не передал содержимое")
})

test("стандартный UI bridge инициализируется без window.openai и освобождает mount", async () => {
  const elements = new Map<string, any>()
  for (const id of ["status", "source", "text", "image", "figure", "caption", "fullscreen", "pip", "inline", "resume"]) {
    elements.set(id, { textContent: "", hidden: false, addEventListener() {} })
  }
  const events = new Map<string, (event: any) => void>()
  const messages: any[] = []
  const parent = { postMessage(message: unknown) { messages.push(message) } }
  const window = { parent, addEventListener(name: string, handler: (event: any) => void) { events.set(name, handler) } }
  const script = viewerUiHtml.match(/<script>([\s\S]*?)<\/script>/)![1]!
  runInNewContext(script, { window, document: { body: { dataset: {} }, getElementById: (id: string) => elements.get(id) },
    crypto: { randomUUID: () => "mount" }, setTimeout: () => 1, clearTimeout() {} })
  const send = (data: unknown) => events.get("message")!({ source: parent, data: { jsonrpc: "2.0", ...data as object } })
  expect(messages[0]).toMatchObject({ method: "ui/initialize", params: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] } } })
  send({ id: "viewer-initialize", result: { hostContext: { availableDisplayModes: ["inline", "fullscreen", "pip"] } } })
  send({ method: "ui/notifications/tool-result", params: { _meta: { viewer: { viewerId: "view", accessToken: "token", version: 0 } } } })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const call = messages.find(message => message.method === "tools/call")
  expect(call.params.name).toBe("codex_app_next")
  send({ id: call.id, result: { _meta: { viewer: { version: 1, content: { kind: "text", service: "demo-b", text: "Данные" } } } } })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(elements.get("text").textContent).toBe("Данные")
  send({ id: "teardown", method: "ui/resource-teardown" })
  expect(messages.find(message => message.params?.arguments?.release)).toMatchObject({ params: { arguments: { mountId: "mount", release: true } } })
  expect(messages.at(-1)).toMatchObject({ id: "teardown", result: {} })
})

test("снимок подтверждается после декодирования; ожидание не запрашивает захват экрана", async () => {
  const elements = new Map<string, any>()
  for (const id of ["status", "source", "text", "image", "figure", "caption", "fullscreen", "pip", "inline", "resume"]) {
    elements.set(id, { textContent: "", hidden: false, addEventListener() {} })
  }
  let decode: () => void = () => {}
  const image = elements.get("image")
  image.decode = () => new Promise<void>(resolve => { decode = resolve })
  const calls: Array<{ name: string, args: any }> = []
  let deliver: (value: unknown) => void = () => {}
  const window = { parent: { postMessage() {} }, addEventListener() {}, openai: {
    toolResponseMetadata: { _meta: { viewer: { viewerId: "view", accessToken: "token", version: 1,
      content: { kind: "image", service: "computer", mimeType: "image/png", data: "first", caption: "Первый" } } } },
    callTool(name: string, args: unknown) {
      calls.push({ name, args })
      return new Promise(resolve => { deliver = resolve })
    },
  } }
  runInNewContext(viewerUiHtml.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    window, document: { body: { dataset: {} }, getElementById: (id: string) => elements.get(id) },
    crypto: { randomUUID: () => "mount" }, setTimeout, clearTimeout,
  })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  await flush()
  expect(calls).toHaveLength(0)
  decode()
  await flush()
  expect(calls[0]).toMatchObject({ name: "codex_app_next", args: { after: 1, displayedVersion: 1 } })
  deliver({ _meta: { viewer: { version: 1, changed: false } } })
  await flush()
  expect(image.src).toBe("data:image/png;base64,first")
  expect(calls[1]).toMatchObject({ name: "codex_app_next", args: { after: 1, displayedVersion: 1 } })
  deliver({ _meta: { viewer: { version: 2, changed: true,
    content: { kind: "image", service: "computer", mimeType: "image/png", data: "second", caption: "Второй" } } } })
  await flush()
  expect(calls).toHaveLength(2)
  expect(elements.get("image")).toBe(image)
  expect(image.src).toBe("data:image/png;base64,second")
  decode()
  await flush()
  expect(calls[2]).toMatchObject({ name: "codex_app_next", args: { after: 2, displayedVersion: 2, mountId: "mount" } })
  expect(elements.get("caption").textContent).toBe("Второй")
})
