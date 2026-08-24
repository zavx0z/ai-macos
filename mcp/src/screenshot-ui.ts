export const SCREENSHOT_UI_URI = "ui://widget/ai-macos-screenshot-v5.html"

export const SCREENSHOT_UI_DOMAIN =
  "https://ai-macos-local.zavx0z.app"

export const screenshotUiHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 8px; background: transparent; color: CanvasText; }
      figure { margin: 0; overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 12px; background: Canvas; }
      img { display: block; width: 100%; height: auto; max-height: none; object-fit: contain; background: #111; cursor: zoom-in; }
      figcaption { padding: 8px 10px; display: flex; gap: 8px; justify-content: space-between; align-items: baseline; font-size: 13px; }
      #caption { font-weight: 600; overflow-wrap: anywhere; }
      #actions { display: flex; gap: 8px; align-items: center; flex: none; }
      #details { opacity: .65; white-space: nowrap; }
      #expand { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 999px; padding: 5px 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      #expand:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
      #empty { padding: 24px; text-align: center; opacity: .7; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <figure id="viewer" hidden>
      <img id="image" alt="macOS screenshot" />
      <figcaption>
        <span id="caption">macOS screenshot</span>
        <span id="actions">
          <span id="details"></span>
          <button id="expand" type="button" title="Open the screenshot at full size">Expand</button>
        </span>
      </figcaption>
    </figure>
    <div id="empty" role="status">Waiting for screenshot…</div>

    <script>
      const viewer = document.getElementById("viewer");
      const image = document.getElementById("image");
      const caption = document.getElementById("caption");
      const details = document.getElementById("details");
      const expand = document.getElementById("expand");
      const empty = document.getElementById("empty");
      let lastReportedHeight = 0;
      let lastVersion = 0;
      let heightFrame;
      let pipRequested = false;
      let refreshInFlight = false;

      function notifyHeight() {
        cancelAnimationFrame(heightFrame);
        heightFrame = requestAnimationFrame(() => {
          const height = Math.ceil(Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          ));
          if (!height || height === lastReportedHeight) return;
          lastReportedHeight = height;

          try {
            window.openai?.notifyIntrinsicHeight?.(height);
          } catch {}

          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/size-changed",
            params: { height },
          }, "*");
        });
      }

      async function expandImage() {
        if (typeof window.openai?.requestDisplayMode === "function") {
          await window.openai.requestDisplayMode({ mode: "fullscreen" });
          return;
        }
        if (typeof window.openai?.requestModal === "function") {
          await window.openai.requestModal({});
        }
      }

      async function enterPip() {
        if (pipRequested || typeof window.openai?.requestDisplayMode !== "function") return;
        try {
          await window.openai.requestDisplayMode({ mode: "pip" });
          pipRequested = true;
        } catch {}
      }

      function render(toolResult) {
        const result = toolResult?.mcp_tool_result ?? toolResult?.call_tool_result ?? toolResult?.result ?? toolResult ?? {};
        const content = Array.isArray(result.content) ? result.content : [];
        const imageBlock = content.find((item) => item?.type === "image" && typeof item?.data === "string");
        const privateImage = result._meta?.screenshot;
        const metadata = result.structuredContent ?? {};
        if (typeof metadata.version === "number") lastVersion = metadata.version;
        const imageData = imageBlock?.data ?? privateImage?.data;
        if (typeof imageData !== "string") return;

        const mimeType = imageBlock?.mimeType || privateImage?.mimeType || "image/png";
        image.src = "data:" + mimeType + ";base64," + imageData;
        image.alt = metadata.caption || "macOS screenshot";
        caption.textContent = metadata.caption || metadata.target || "macOS screenshot";
        const windowTitle = metadata.window?.title;
        details.textContent = windowTitle || metadata.target || "";
        empty.hidden = true;
        viewer.hidden = false;
        notifyHeight();
      }

      async function refreshLatest() {
        if (refreshInFlight || typeof window.openai?.callTool !== "function") return;
        refreshInFlight = true;
        try {
          const result = await window.openai.callTool("latest_capture", { after: lastVersion });
          render(result);
        } catch {} finally {
          refreshInFlight = false;
        }
      }

      image.addEventListener("load", notifyHeight, { passive: true });
      image.addEventListener("click", expandImage);
      expand.addEventListener("click", expandImage);

      if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(notifyHeight);
        observer.observe(document.documentElement);
        observer.observe(document.body);
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") render(message.params);
      }, { passive: true });

      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals;
        render(globals?.toolResponseMetadata);
        void enterPip();
        void refreshLatest();
      }, { passive: true });

      render(window.openai?.toolResponseMetadata);
      render(window.openai?.toolOutput);
      void enterPip();
      void refreshLatest();
      window.setInterval(refreshLatest, 1000);
      notifyHeight();
    </script>
  </body>
</html>`
