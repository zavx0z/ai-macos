import {
  activateTab,
  closeTab,
  ensureForward,
  evalJs,
  getActiveTab,
  getSource,
  getText,
  listTabs,
  navigate,
  newTab,
  reload,
  screenshot,
} from "./android.ts"
import { adbAvailable, adbDevices, adbForward } from "./adb.ts"
import { err, json, logRequest, parseBool, printBanner } from "@meta/shared"

const PORT = Number(Bun.env.PORT ?? 7881)

// Try to set up forward on startup; failures are non-fatal — endpoints will report
ensureForward().catch((e) => {
  console.error(`  initial adb forward failed: ${e instanceof Error ? e.message : String(e)}`)
})

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const t0 = performance.now()
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    const res = await (async () => {
      try {
        if (path === "/health") {
          const adb = await adbAvailable()
          if (!adb) {
            return json({
              ok: false,
              adb: false,
              error: "adb not found",
              hint: "Установите Android platform-tools: brew install --cask android-platform-tools",
            })
          }
          const devices = await adbDevices()
          const ready = devices.find((d) => d.state === "device")
          if (!ready) {
            return json({
              ok: false,
              adb: true,
              devices,
              hint: "Подключите телефон по USB и включите USB Debugging в Developer options",
            })
          }
          // Try CDP HTTP — verifies forward is set up and Chrome remote debug is reachable
          try {
            const r = await fetch("http://localhost:9222/json/version")
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const v = await r.json() as { Browser?: string; "User-Agent"?: string }
            return json({ ok: true, adb: true, devices, browser: v.Browser, userAgent: v["User-Agent"] })
          } catch (e) {
            return json({
              ok: false,
              adb: true,
              devices,
              error: e instanceof Error ? e.message : String(e),
              hint: "Откройте Chrome на телефоне и chrome://inspect/#devices на маке. Если не помогает — adb forward tcp:9222 localabstract:chrome_devtools_remote",
            })
          }
        }

        if (path === "/devices" && method === "GET") {
          return json({ devices: await adbDevices() })
        }

        if (path === "/forward" && method === "POST") {
          await ensureForward()
          return json({ ok: true })
        }

        if (path === "/tabs" && method === "GET") {
          return json({ tabs: await listTabs() })
        }

        if (path === "/tabs/active" && method === "GET") {
          const t = await getActiveTab()
          if (!t) return err(404, "no active tab", "Откройте Chrome на телефоне и хотя бы одну вкладку")
          return json(t)
        }

        if (path === "/tabs" && method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { url?: string }
          const t = await newTab(body.url)
          return json({ ok: true, tab: t })
        }

        const tabMatch = path.match(/^\/tabs\/([^\/]+)$/)
        if (tabMatch && method === "DELETE") {
          await closeTab(tabMatch[1]!)
          return json({ ok: true })
        }

        if (path === "/activate" && method === "POST") {
          const body = (await req.json()) as { tabId?: string }
          if (!body.tabId) return err(400, "missing 'tabId'", "Получите tabId из GET /tabs")
          await activateTab(body.tabId)
          return json({ ok: true, tabId: body.tabId })
        }

        if (path === "/navigate" && method === "POST") {
          const body = (await req.json()) as { url?: string; tabId?: string }
          if (!body.url) return err(400, "missing 'url'", "Пример: {\"url\":\"https://example.com\"}")
          await navigate(body.url, body.tabId)
          return json({ ok: true })
        }

        if (path === "/reload" && method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { tabId?: string; hard?: boolean; wait?: boolean }
          const wait = body.wait !== false
          const waitMs = await reload(body.tabId, wait, body.hard === true)
          return json({ ok: true, hard: body.hard === true, waited: wait, waitMs })
        }

        if (path === "/eval" && method === "POST") {
          const body = (await req.json()) as { js?: string; tabId?: string }
          if (!body.js) return err(400, "missing 'js'", "Пример: {\"js\":\"return document.title\"}")
          const result = await evalJs(body.js, body.tabId)
          return json({ ok: true, result })
        }

        if (path === "/source" && method === "GET") {
          const tabId = url.searchParams.get("tabId") ?? undefined
          const html = await getSource(tabId)
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        }

        if (path === "/text" && method === "GET") {
          const tabId = url.searchParams.get("tabId") ?? undefined
          const text = await getText(tabId)
          return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } })
        }

        if (path === "/screenshot" && (method === "GET" || method === "POST")) {
          const opts = method === "POST"
            ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
            : {
                tabId: url.searchParams.get("tabId") ?? undefined,
                detail: url.searchParams.get("detail") ?? undefined,
                caption: url.searchParams.get("caption") ?? undefined,
                fullPage: parseBool(url.searchParams.get("fullPage")),
                format: (url.searchParams.get("format") === "json" ? "json" : "png") as "png" | "json",
              }
          const result = await screenshot(opts as Parameters<typeof screenshot>[0])
          if (result.contentType === "application/json") {
            return json({
              ok: true,
              target: "android-tab",
              mime: "image/png",
              ...(result.caption ? { caption: result.caption } : {}),
              base64: result.base64,
            })
          }
          const headers: Record<string, string> = { "content-type": result.contentType, "cache-control": "no-store" }
          if (result.caption) headers["x-meta-caption"] = encodeURIComponent(result.caption)
          return new Response(result.body, { headers })
        }

        return err(404, `${method} ${path} not found`,
          "Доступные маршруты: GET /health /devices /tabs /tabs/active /source /text /screenshot, POST /forward /tabs /activate /navigate /reload /eval /screenshot, DELETE /tabs/:id")
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        let hint: string | undefined
        if (msg.includes("adb forward failed") || msg.includes("CDP /json")) {
          hint = "Проверьте: 1) телефон подключён (GET /devices), 2) USB debugging включён, 3) Chrome открыт на телефоне"
        } else if (msg.includes("no Chrome tabs")) {
          hint = "Откройте Chrome на телефоне и хотя бы одну вкладку"
        } else if (msg.includes("CDP WS error")) {
          hint = "WebSocket соединение к Chrome не установлено. Перезапустите forward: POST /forward"
        }
        return err(500, msg, hint)
      }
    })()
    logRequest(method, path, res.status, Math.round(performance.now() - t0))
    return res
  },
})

printBanner("@meta/android", PORT, [
  { routes: [
    { method: "GET", path: "/health", description: "состояние ADB и CDP" },
  ]},
  { title: "Устройства", routes: [
    { method: "GET",  path: "/devices",  description: "список подключённых Android" },
    { method: "POST", path: "/forward",  description: "пересоздать adb forward 9222" },
  ]},
  { title: "Вкладки Chrome на телефоне", routes: [
    { method: "GET",    path: "/tabs",         description: "список вкладок" },
    { method: "GET",    path: "/tabs/active",  description: "активная (первая) вкладка" },
    { method: "POST",   path: "/tabs",         description: "открыть вкладку  ({url?})" },
    { method: "DELETE", path: "/tabs/:id",     description: "закрыть вкладку" },
    { method: "POST",   path: "/activate",     description: "активировать  ({tabId})" },
  ]},
  { title: "Навигация", routes: [
    { method: "POST", path: "/navigate", description: "перейти по URL  ({url,tabId?})" },
    { method: "POST", path: "/reload",   description: "перезагрузить  ({tabId?,hard?,wait?})" },
  ]},
  { title: "Контент", routes: [
    { method: "POST", path: "/eval",   description: "выполнить JS  ({js,tabId?})" },
    { method: "GET",  path: "/source", description: "HTML  (?tabId=)" },
    { method: "GET",  path: "/text",   description: "innerText  (?tabId=)" },
  ]},
  { title: "Скриншот", routes: [
    { method: "GET",  path: "/screenshot", description: "(?tabId=&detail=&caption=&fullPage=)" },
    { method: "POST", path: "/screenshot", description: "({tabId?,detail?,scale?,caption?,fullPage?})" },
  ]},
])
console.log(`  ADB forward → localhost:9222 → localabstract:chrome_devtools_remote`)
