export const VIEWER_UI_URI = "ui://zavx0z/codex-app-v2.html"

/** Прототип общего приложения: один mount, ожидающие MCP-запросы, fullscreen и PiP. */
export const viewerUiHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; overflow: hidden; }
    body { color: CanvasText; background: Canvas; }
    #app { width: 100%; margin: 0 auto; overflow: hidden; }
    header { height: 44px; display: flex; gap: 6px; align-items: center; padding: 6px 8px; overflow: hidden; }
    h1 { font-size: 13px; margin: 0 6px 0 0; white-space: nowrap; }
    button { padding: 5px 9px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
    .mode-icon { display: none; }
    #status { font-size: 11px; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    main { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #101114; color: #f4f4f5; }
    figure { position: absolute; inset: 0; margin: 0; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; }
    figcaption { position: absolute; bottom: 0; left: 0; right: 0; padding: 5px 8px; font-size: 11px; background: #000a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #source { position: absolute; top: 8px; left: 10px; margin: 0; font-size: 12px; opacity: .7; z-index: 1; }
    pre { position: absolute; inset: 30px 10px 10px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; font: inherit; font-size: 14px; }
    body[data-mode="fullscreen"] #app, body[data-mode="pip"] #app { max-width: calc((100dvh - 44px) * 16 / 9); }
    body[data-mode="pip"] h1, body[data-mode="pip"] #status, body[data-mode="pip"] .mode-label { display: none; }
    body[data-mode="pip"] .mode-icon { display: inline; }
    @media (max-width: 480px) { h1, #status, .mode-label { display: none; } .mode-icon { display: inline; } }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div id="app">
  <header>
    <h1>Codex App</h1>
    <button id="fullscreen" aria-label="На весь экран" title="На весь экран"><span class="mode-icon" aria-hidden="true">⛶</span><span class="mode-label">На весь экран</span></button>
    <button id="pip" aria-label="Поверх чата" title="Поверх чата"><span class="mode-icon" aria-hidden="true">▣</span><span class="mode-label">Поверх чата</span></button>
    <button id="inline" aria-label="В чате" title="В чате"><span class="mode-icon" aria-hidden="true">↙</span><span class="mode-label">В чате</span></button>
    <button id="resume" title="Возобновить обновления" hidden>↻</button>
    <span id="status" role="status">Подключение…</span>
  </header>
  <main>
    <h2 id="source"></h2>
    <figure id="figure" hidden>
      <img id="image" alt="">
      <figcaption id="caption"></figcaption>
    </figure>
    <pre id="text">Ожидание данных сервисов</pre>
  </main>
  </div>
  <script>
    const status = document.getElementById("status")
    const image = document.getElementById("image")
    const figure = document.getElementById("figure")
    const caption = document.getElementById("caption")
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
      for (let depth = 0; depth < 5; depth++) {
        if (typeof value === "string") {
          try { value = JSON.parse(value) } catch { return {} }
        }
        if (!value || typeof value !== "object") return {}
        if (value.mcp_tool_result) {
          value = value.mcp_tool_result
          continue
        }
        if (value.call_tool_result) {
          value = value.call_tool_result
          continue
        }
        // callTool возвращает полный envelope и legacy result-строку рядом.
        // Строка не должна скрывать structuredContent и приватную metadata.
        if (value._meta || value.meta || value.structuredContent || Array.isArray(value.content)) {
          return { ...value, _meta: value._meta ?? value.meta }
        }
        if (value.result === undefined) return value
        value = value.result
      }
      return {}
    }

    async function render(snapshot) {
      if (!snapshot || snapshot.version < version) return
      version = snapshot.version ?? version
      const content = snapshot.content
      if (!content) return
      source.textContent = content.service
      if (content.kind === "image") {
        const url = "data:" + content.mimeType + ";base64," + content.data
        image.alt = content.caption
        caption.textContent = content.caption
        image.src = url
        figure.hidden = false
        text.hidden = true
        try {
          if (typeof image.decode === "function") await image.decode()
          else await new Promise((resolve, reject) => {
            if (image.complete && image.naturalWidth > 0) return resolve()
            image.onload = resolve
            image.onerror = () => reject(new Error("Изображение не загружено"))
          })
          if (image.src === url && version === snapshot.version) displayedVersion = snapshot.version
        } catch { throw new Error("Не удалось показать снимок. Нажмите Возобновить обновления.") }
      } else {
        text.textContent = content.text
        text.hidden = false
        figure.hidden = true
        displayedVersion = snapshot.version
      }
    }

    async function next() {
      const args = { viewerId: viewer.viewerId, accessToken: viewer.accessToken,
        after: version, mountId, displayedVersion, displayMode, waitMs: 20000 }
      const response = typeof window.openai?.callTool === "function"
        ? await window.openai.callTool("codex_app_next", args)
        : await request("tools/call", { name: "codex_app_next", arguments: args })
      const result = unwrap(response)
      if (result.isError) throw new Error(result.content?.find(item => item.type === "text")?.text ?? "Ошибка обновления")
      const snapshot = result._meta?.viewer ?? result.structuredContent
      if (!snapshot || typeof snapshot.version !== "number") {
        throw new Error("Хост вернул неизвестный формат обновления приложения")
      }
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
        ? window.openai.callTool("codex_app_next", args)
        : request("tools/call", { name: "codex_app_next", arguments: args })
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
          await render(snapshot)
          status.textContent = "Связь активна · ревизия " + version + " · " + displayMode
        }
      } catch (error) {
        status.textContent = error.message
        resume.hidden = false
      } finally { running = false }
    }

    async function accept(value) {
      const result = unwrap(value)
      if (result.isError) {
        status.textContent = result.content?.find(item => item.type === "text")?.text ?? "Не удалось открыть приложение"
        return
      }
      const incoming = result._meta?.viewer
      if (!incoming?.viewerId || !incoming.accessToken) return
      if (viewer && viewer.viewerId !== incoming.viewerId) return
      viewer = incoming
      try {
        await render(incoming)
        void listen()
      } catch (error) {
        status.textContent = error.message
        resume.hidden = false
      }
    }

    function reportSize() {
      const app = document.getElementById("app")
      if (!app?.getBoundingClientRect) return
      const height = Math.ceil(app.getBoundingClientRect().height)
      if (height > 0 && typeof window.openai?.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight(height)
      }
    }
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(reportSize)
      observer.observe(document.getElementById("app"))
      window.addEventListener("pagehide", () => observer.disconnect())
    }

    function syncMode(mode) {
      displayMode = mode ?? displayMode
      document.body.dataset.mode = displayMode
      reportSize()
    }

    for (const mode of ["fullscreen", "pip", "inline"]) {
      document.getElementById(mode).addEventListener("click", async () => {
        try {
          if (availableModes.length > 0 && !availableModes.includes(mode)) {
            throw new Error("Хост не объявил режим " + mode)
          }
          const result = typeof window.openai?.requestDisplayMode === "function"
            ? await window.openai.requestDisplayMode({ mode })
            : await request("ui/request-display-mode", { mode })
          syncMode(result?.mode ?? window.openai?.displayMode ?? "unknown")
          status.textContent = displayMode === mode ? "Режим: " + displayMode : "Хост оставил режим: " + displayMode
        } catch (error) { status.textContent = error.message }
      })
    }
    resume.addEventListener("click", () => {
      version = displayedVersion
      void listen()
    })
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
        syncMode(message.result?.hostContext?.displayMode)
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
      if (message.method === "ui/notifications/tool-result") void accept(message.params)
      if (message.method === "ui/notifications/host-context-changed") {
        syncMode(message.params?.displayMode)
        availableModes = message.params?.availableDisplayModes ?? availableModes
      }
      if (message.method === "ui/resource-teardown") {
        dispose()
        window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*")
      }
    })
    window.addEventListener("openai:set_globals", event => {
      syncMode(event.detail?.globals?.displayMode)
      void accept(event.detail?.globals?.toolResponseMetadata)
    })
    window.addEventListener("pagehide", dispose)
    window.parent.postMessage({ jsonrpc: "2.0", id: initializeId, method: "ui/initialize", params: {
      protocolVersion: "2026-01-26", appInfo: { name: "Codex App", version: "1" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    } }, "*")
    void accept(window.openai?.toolResponseMetadata)
  </script>
</body>
</html>`
