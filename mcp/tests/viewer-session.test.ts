import { expect, test } from "bun:test"
import { ViewerSessions, viewerScope } from "../src/viewer-session.ts"
import { startChatProxy } from "../src/chat-proxy.ts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

test("новая ревизия будит ожидающий запрос, другая беседа не меняется", async () => {
  const views = new ViewerSessions()
  const a = views.open("a")
  const b = views.open("b")
  const waiting = views.next({ ...a, after: 0 }, new AbortController().signal)
  expect(views.status("a").pending).toBe(true)
  views.publish("a", { kind: "text", service: "demo-a", text: "Первый сервис" })
  expect(await waiting).toMatchObject({ version: 1, content: { service: "demo-a" } })
  expect(views.status("a").pending).toBe(false)
  expect(await views.next({ ...b, after: 0, waitMs: 0 }, new AbortController().signal)).toEqual({ version: 0, changed: false })
  expect(views.open("a").viewerId).toBe(a.viewerId)
  views.close()
})

test("чужой token отвергается, отмена запроса освобождает ожидание", async () => {
  const views = new ViewerSessions()
  const a = views.open("a")
  const b = views.open("b")
  await expect(views.next({ ...a, accessToken: b.accessToken, after: 0 }, new AbortController().signal)).rejects.toThrow("UNAVAILABLE")
  const abort = new AbortController()
  const waiting = views.next({ ...a, after: 0 }, abort.signal)
  abort.abort()
  await expect(waiting).rejects.toThrow("CANCELLED")
  expect(views.status("a").pending).toBe(false)
  views.close()
})

test("один mount принимает сервисы по очереди; timeout не создаёт новую ревизию", async () => {
  const views = new ViewerSessions()
  const a = views.open("a")
  await views.next({ ...a, after: 0, waitMs: 1, mountId: "first" }, new AbortController().signal)
  await expect(views.next({ ...a, after: 0, mountId: "second" }, new AbortController().signal)).rejects.toThrow("ALREADY_MOUNTED")
  views.publish("a", { kind: "text", service: "demo-a", text: "A" })
  views.publish("a", { kind: "text", service: "demo-b", text: "B" })
  const r = await views.next({ ...a, after: 1, mountId: "first", displayedVersion: 1, displayMode: "fullscreen" }, new AbortController().signal)
  expect(r).toMatchObject({ version: 2, content: { service: "demo-b" } })
  expect(views.status("a")).toMatchObject({ mountId: "first", displayMode: "fullscreen", displayedVersion: 1 })
  views.close()
})

test("без идентификатора беседы нет общей запасной session", () => {
  expect(viewerScope({})).toBeUndefined()
  expect(() => new ViewerSessions().open(undefined)).toThrow("SCOPE_UNAVAILABLE")
  expect(viewerScope({ "openai/session": "a" })).not.toBe(viewerScope({ "openai/session": "b" }))
})

test("запоздавшая публикация не меняет новое содержимое и release разрешает повторное открытие", async () => {
  const views = new ViewerSessions()
  const view = views.open("a")
  views.publish("a", { kind: "text", service: "demo-b", text: "новое" }, 2)
  expect(views.publish("a", { kind: "text", service: "demo-a", text: "старое" }, 1)).toMatchObject({ discarded: true, version: 1 })
  const signal = new AbortController().signal
  await views.next({ ...view, mountId: "first", after: 0 }, signal)
  await views.next({ ...view, mountId: "first", after: 1, release: true }, signal)
  expect(await views.next({ ...view, mountId: "second", after: 0 }, signal)).toMatchObject({ content: { text: "новое" } })
  views.close()
})

test("MCP передаёт метаданные беседы, два сервиса обновляют один просмотр без UI-шаблонов", async () => {
  const server = await startChatProxy({ runtime: { expectedHostname: "unused", socketPath: "/missing", credentialPath: "/missing" } })
  const client = new Client({ name: "viewer-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const meta = { "openai/session": "conversation:a" }
  const call = (name: string, args: Record<string, unknown>, _meta = meta) => client.callTool({ name, arguments: args, _meta })
  try {
    await Promise.all([client.connect(ct), server.connect(st)])
    const opened = await call("zavx0z_viewer", {})
    const view = opened._meta?.viewer as { viewerId: string, accessToken: string }
    expect(view.viewerId).toBeString()
    const wait = call("zavx0z", { node: "viewer", action: "wait", input: { after: 0, waitMs: 1000 } })
    await call("zavx0z", { node: "viewer", action: "publish_demo", input: { service: "demo-a", text: "A" } })
    expect((await wait).structuredContent).toMatchObject({ content: { service: "demo-a" }, version: 1 })
    await call("zavx0z", { node: "viewer", action: "publish_demo", input: { service: "demo-b", text: "B" } })
    const frame = await call("zavx0z_viewer_next", { viewerId: view.viewerId, accessToken: view.accessToken, after: 1 })
    expect(frame._meta?.viewer).toMatchObject({ version: 2, content: { service: "demo-b" } })
    expect(frame.content).toMatchObject([{ type: "text" }])
    expect((await call("zavx0z", { node: "viewer", action: "status" }, { "openai/session": "conversation:b" })).structuredContent)
      .toMatchObject({ viewerId: null, version: 0 })
    const descriptors = (await client.listTools()).tools
    expect(descriptors.filter(tool => tool._meta?.["openai/outputTemplate"]).map(tool => tool.name)).toEqual(["zavx0z_viewer"])
  } finally {
    await client.close()
    await server.close()
  }
})
