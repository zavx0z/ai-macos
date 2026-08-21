export const SCREENSHOT_UI_URI = "ui://ai-macos/screenshot.html"

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
      img { display: block; width: 100%; max-height: 70vh; object-fit: contain; background: #111; }
      figcaption { padding: 8px 10px; display: flex; gap: 8px; justify-content: space-between; align-items: baseline; font-size: 13px; }
      #caption { font-weight: 600; overflow-wrap: anywhere; }
      #details { opacity: .65; white-space: nowrap; }
      #empty { padding: 24px; text-align: center; opacity: .7; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <figure id="viewer" hidden>
      <img id="image" alt="macOS screenshot" />
      <figcaption>
        <span id="caption">macOS screenshot</span>
        <span id="details"></span>
      </figcaption>
    </figure>
    <div id="empty" role="status">Waiting for screenshot…</div>

    <script>
      const viewer = document.getElementById("viewer");
      const image = document.getElementById("image");
      const caption = document.getElementById("caption");
      const details = document.getElementById("details");
      const empty = document.getElementById("empty");

      function render(toolResult) {
        const result = toolResult?.result ?? toolResult ?? {};
        const content = Array.isArray(result.content) ? result.content : [];
        const imageBlock = content.find((item) => item?.type === "image" && typeof item?.data === "string");
        const metadata = result.structuredContent ?? {};
        if (!imageBlock) return;

        const mimeType = imageBlock.mimeType || "image/png";
        image.src = "data:" + mimeType + ";base64," + imageBlock.data;
        image.alt = metadata.caption || "macOS screenshot";
        caption.textContent = metadata.caption || metadata.target || "macOS screenshot";
        const windowTitle = metadata.window?.title;
        details.textContent = windowTitle || metadata.target || "";
        empty.hidden = true;
        viewer.hidden = false;
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") render(message.params);
      }, { passive: true });

      if (window.openai?.toolOutput) render(window.openai.toolOutput);
    </script>
  </body>
</html>`
