export const VIEWER_UI_URI = "ui://zavx0z/viewer-v1.html"

/** Прототип общего приложения: один mount, ожидающие MCP-запросы и явный fullscreen. */
export const viewerUiHtml = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 16px; color: CanvasText; background: Canvas; }
    header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    h1 { font-size: 18px; margin: 0; }
    button { padding: 8px 14px; cursor: pointer; font: inherit; }
    #status { opacity: .75; }
    main { margin-top: 16px; min-height: 120px; }
    img { max-width: 100%; max-height: 80vh; object-fit: contain; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <header>
    <h1>Завхоз</h1>
    <button id="fullscreen">Развернуть приложение</button>
    <button id="resume" hidden>Возобновить обновления</button>
    <span id="status" role="status">Подключение…</span>
  </header>
  <main>
    <h2 id="source"></h2>
    <img id="image" hidden alt="">
    <pre id="text">Ожидание данных сервисов</pre>
  </main>
  <script>
    const status = document.getElementById("status")
    const image = document.getElementById("image")
    const text = document.getElementById("text")
    const source = document.getElementById("source")
    const resume = document.getElementById("resume")
    const mountId = crypto.randomUUID()
    let viewer
    let version = 0
    let displayedVersion = 0
    let displayMode = "inline"
    let running = false
    let disposed = false
    let bridgeReady = false
    let availableModes = []
    let requestId = 0
    const pending = new Map()
    const initializeId = "viewer-initialize"

    function request(method, params) {
      if (!bridgeReady) return Promise.reject(new Error("UI bridge ещё не готов"))
      const id = ++requestId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Истекло время ожидания ответа хоста"))
        }, 30000)
        pending.set(id, { resolve, reject, timer })
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*")
      })
    }

    function unwrap(value) {
      return value?.mcp_tool_result ?? value?.call_tool_result ?? value?.result ?? value ?? {}
    }

    function render(snapshot) {
      if (!snapshot || snapshot.version < version) return
      version = snapshot.version ?? version
      const content = snapshot.content
      if (!content) return
      source.textContent = content.service
      if (content.kind === "image") {
        const url = "data:" + content.mimeType + ";base64," + content.data
        image.onload = () => { if (image.src === url) displayedVersion = snapshot.version }
        image.onerror = () => { status.textContent = "Не удалось показать изображение" }
        image.alt = content.caption
        image.src = url
        image.hidden = false
        text.hidden = true
      } else {
        text.textContent = content.text
        text.hidden = false
        image.hidden = true
        displayedVersion = snapshot.version
      }
    }

    async function next() {
      const args = { viewerId: viewer.viewerId, accessToken: viewer.accessToken,
        after: version, mountId, displayedVersion, displayMode, waitMs: 20000 }
      const response = typeof window.openai?.callTool === "function"
        ? await window.openai.callTool("zavx0z_viewer_next", args)
        : await request("tools/call", { name: "zavx0z_viewer_next", arguments: args })
      const result = unwrap(response)
      if (result.isError) throw new Error(result.content?.find(item => item.type === "text")?.text ?? "Ошибка обновления")
      const snapshot = result._meta?.viewer ?? result.structuredContent
      if (snapshot?.changed && snapshot.version > version && !snapshot.content) {
        throw new Error("Хост не передал содержимое новой ревизии приложения")
      }
      return snapshot
    }

    function dispose() {
      disposed = true
      if (!viewer) return
      const args = { viewerId: viewer.viewerId, accessToken: viewer.accessToken, after: version, mountId, release: true, waitMs: 0 }
      const released = typeof window.openai?.callTool === "function"
        ? window.openai.callTool("zavx0z_viewer_next", args)
        : request("tools/call", { name: "zavx0z_viewer_next", arguments: args })
      void released.catch(() => {})
    }

    async function listen() {
      if (running || disposed || !viewer || !(bridgeReady || window.openai?.callTool)) return
      running = true
      resume.hidden = true
      try {
        while (!disposed) {
          const snapshot = await next()
          if (disposed) break
          render(snapshot)
          status.textContent = "Связь активна · ревизия " + version + " · " + displayMode
        }
      } catch (error) {
        status.textContent = error.message
        resume.hidden = false
      } finally { running = false }
    }

    function accept(value) {
      const result = unwrap(value)
      if (result.isError) {
        status.textContent = result.content?.find(item => item.type === "text")?.text ?? "Не удалось открыть приложение"
        return
      }
      const incoming = result._meta?.viewer
      if (!incoming?.viewerId || !incoming.accessToken) return
      if (viewer && viewer.viewerId !== incoming.viewerId) return
      viewer = incoming
      render(incoming)
      void listen()
    }

    document.getElementById("fullscreen").addEventListener("click", async () => {
      try {
        if (!window.openai?.requestDisplayMode && !availableModes.includes("fullscreen")) {
          throw new Error("Хост не объявил режим fullscreen")
        }
        const result = typeof window.openai?.requestDisplayMode === "function"
          ? await window.openai.requestDisplayMode({ mode: "fullscreen" })
          : await request("ui/request-display-mode", { mode: "fullscreen" })
        displayMode = result?.mode ?? window.openai?.displayMode ?? "unknown"
        status.textContent = displayMode === "fullscreen" ? "Приложение развёрнуто" : "Хост оставил режим: " + displayMode
      } catch (error) { status.textContent = error.message }
    })
    resume.addEventListener("click", () => { void listen() })
    window.addEventListener("message", event => {
      if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return
      const message = event.data
      if (message.id === initializeId) {
        if (message.error) {
          status.textContent = message.error.message
          return
        }
        bridgeReady = true
        availableModes = message.result?.hostContext?.availableDisplayModes ?? []
        displayMode = message.result?.hostContext?.displayMode ?? displayMode
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*")
        void listen()
        return
      }
      const waiting = pending.get(message.id)
      if (waiting) {
        clearTimeout(waiting.timer)
        pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message))
        else waiting.resolve(message.result)
        return
      }
      if (message.method === "ui/notifications/tool-result") accept(message.params)
      if (message.method === "ui/notifications/host-context-changed") displayMode = message.params?.displayMode ?? displayMode
      if (message.method === "ui/resource-teardown") {
        dispose()
        window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*")
      }
    })
    window.addEventListener("openai:set_globals", event => {
      displayMode = event.detail?.globals?.displayMode ?? displayMode
      accept(event.detail?.globals?.toolResponseMetadata)
    })
    window.addEventListener("pagehide", dispose)
    window.parent.postMessage({ jsonrpc: "2.0", id: initializeId, method: "ui/initialize", params: {
      protocolVersion: "2026-01-26", appInfo: { name: "Завхоз", version: "1" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    } }, "*")
    accept(window.openai?.toolResponseMetadata)
  </script>
</body>
</html>`
