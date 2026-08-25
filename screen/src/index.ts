import { captureDesktop, captureRect, parseDetail, type CaptureOptions } from "./capture.ts";
import { frontmostApp } from "./restore.ts";
import { createWindowApi, type WindowApi, type WindowInfo } from "./window-api.ts";
import { clamp, err, json, logCaption, logRequest, nonNegativeInt, osa, parseBoolean, png, positiveInt, printBanner, quote, sleep } from "@meta/shared";

const PORT = Number(Bun.env.PORT ?? Bun.env.SCREEN_PORT ?? 7879);
const CHROME_API = Bun.env.CHROME_API ?? "http://localhost:7880";
const windowApi = createWindowApi();

type WindowCaptureRequest = {
  app?: string;
  index?: number;
  title?: string;
  restore?: boolean;
  delayMs?: number;
  shadow?: boolean;
  format?: "png" | "json";
  detail?: string;
  scale?: number;
  caption?: string;
};

type RectCaptureRequest = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  app?: string;
  shadow?: boolean;
  delayMs?: number;
  restore?: boolean;
  format?: "png" | "json";
  detail?: string;
  scale?: number;
  caption?: string;
};

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    const res = await (async () => {
    try {
      if (path === "/health") {
        return await health();
      }

      if (path === "/desktop" && method === "GET") {
        const display = positiveInt(url.searchParams.get("display"), undefined);
        const format = parseFormat(url.searchParams.get("format"));
        const scale = parseDetail(url.searchParams.get("detail") ?? url.searchParams.get("scale"));
        return await desktopResponse({ display, scale }, format);
      }

      if (path === "/desktop" && method === "POST") {
        const body = await readJson<{ display?: number; format?: "png" | "json"; detail?: string; scale?: number }>(req);
        const scale = parseDetail(body.detail ?? String(body.scale ?? ""), 1.0);
        return await desktopResponse({ display: positiveInt(body.display, undefined), scale }, body.format ?? "png");
      }

      if (path === "/windows" && method === "GET") {
        const app = url.searchParams.get("app") ?? undefined;
        const windows = await windowApi.listWindows(app);
        return json({ count: windows.length, windows });
      }

      if (path === "/window" && method === "GET") {
        const request: WindowCaptureRequest = {
          app: url.searchParams.get("app") ?? undefined,
          index: positiveInt(url.searchParams.get("index"), undefined),
          title: url.searchParams.get("title") ?? undefined,
          restore: parseBoolean(url.searchParams.get("restore"), true),
          delayMs: positiveInt(url.searchParams.get("delayMs"), undefined),
          shadow: parseBoolean(url.searchParams.get("shadow"), true),
          format: parseFormat(url.searchParams.get("format")),
          detail: url.searchParams.get("detail") ?? undefined,
          scale: positiveInt(url.searchParams.get("scale"), undefined),
          caption: url.searchParams.get("caption") ?? undefined,
        };
        return await windowResponse(request);
      }

      if (path === "/window" && method === "POST") {
        return await windowResponse(await readJson<WindowCaptureRequest>(req));
      }

      if (path === "/rect" && (method === "GET" || method === "POST")) {
        const input: RectCaptureRequest = method === "POST"
          ? await readJson<RectCaptureRequest>(req)
          : {
              x: nonNegativeInt(url.searchParams.get("x"), undefined),
              y: nonNegativeInt(url.searchParams.get("y"), undefined),
              width: positiveInt(url.searchParams.get("width"), undefined),
              height: positiveInt(url.searchParams.get("height"), undefined),
              app: url.searchParams.get("app") ?? undefined,
              shadow: parseBoolean(url.searchParams.get("shadow"), true),
              delayMs: positiveInt(url.searchParams.get("delayMs"), undefined),
              restore: parseBoolean(url.searchParams.get("restore"), true),
              format: parseFormat(url.searchParams.get("format")),
              detail: url.searchParams.get("detail") ?? undefined,
              scale: positiveInt(url.searchParams.get("scale"), undefined),
              caption: url.searchParams.get("caption") ?? undefined,
            };
        return await rectResponse(input);
      }

      if (path === "/permissions/screen-recording" && method === "GET") {
        return json(await checkScreenRecording());
      }

      if (path === "/permissions/screen-recording" && method === "POST") {
        const proc = Bun.spawn(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
        await proc.exited;
        return json({ ...(await checkScreenRecording()), opened: true });
      }

      return err(404, `${method} ${path} not found`, "Доступные маршруты: GET /health /desktop /windows /window /rect, POST /desktop /window /rect, GET|POST /permissions/screen-recording");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isScreenRecording = msg.includes("screencapture failed") || msg.includes("kCGErrorFailure");
      return err(500, msg, isScreenRecording ? "Нет разрешения Screen Recording. Выдайте его в POST http://localhost:7879/permissions/screen-recording" : undefined);
    }
    })();
    logRequest(method, path, res.status, Math.round(performance.now() - t0));
    return res;
  },
});

printBanner("@meta/screen", PORT, [
  { routes: [
    { method: "GET", path: "/health", description: "состояние сервиса и @meta/window" },
  ]},
  { title: "Рабочий стол", routes: [
    { method: "GET",  path: "/desktop", description: "скриншот экрана  (?detail=low|medium|high|full)" },
    { method: "POST", path: "/desktop", description: "скриншот экрана  ({detail?,scale?})" },
  ]},
  { title: "Окна", routes: [
    { method: "GET",  path: "/windows", description: "список захватываемых окон" },
    { method: "GET",  path: "/window",  description: "скриншот окна  (?app=&detail=)" },
    { method: "POST", path: "/window",  description: "скриншот окна  ({app,detail?,scale?})" },
  ]},
  { title: "Область", routes: [
    { method: "GET",  path: "/rect", description: "скриншот области  (?x=&y=&w=&h=&detail=)" },
    { method: "POST", path: "/rect", description: "скриншот области  ({x,y,width,height,detail?,scale?})" },
  ]},
  { title: "Разрешения", routes: [
    { method: "GET",  path: "/permissions/screen-recording", description: "проверить Screen Recording" },
    { method: "POST", path: "/permissions/screen-recording", description: "открыть Настройки → Конфиденциальность" },
  ]},
]);
console.log(`  WINDOW_API  ${windowApi.baseUrl}`);

async function health(): Promise<Response> {
  try {
    const upstream = await windowApi.health();
    return json({ ok: true, service: "@meta/screen", windowApi: windowApi.baseUrl, window: upstream });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: true, service: "@meta/screen", windowApi: windowApi.baseUrl, window: { ok: false, error: msg } });
  }
}

async function desktopResponse(options: CaptureOptions, format: "png" | "json"): Promise<Response> {
  const image = await captureDesktop(options);
  if (format === "json") {
    return json({
      ok: true,
      target: "desktop",
      mime: "image/png",
      base64: Buffer.from(image).toString("base64"),
    });
  }
  return png(image, { "x-meta-screen-target": "desktop" });
}

async function proxyChromeScreenshot(input: WindowCaptureRequest): Promise<Response> {
  const body: Record<string, unknown> = { restore: input.restore !== false, format: input.format ?? "png" };
  if (input.detail !== undefined) body.detail = input.detail;
  if (input.scale !== undefined) body.scale = input.scale;
  if (input.shadow !== undefined) body.shadow = input.shadow;
  if (input.delayMs !== undefined) body.delayMs = input.delayMs;
  if (input.caption !== undefined) body.caption = input.caption;
  const res = await fetch(`${CHROME_API}/screenshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const buf = await res.arrayBuffer();
  if (!res.ok) {
    const text = new TextDecoder().decode(buf);
    return err(res.status, `chrome proxy: ${text}`, `Убедитесь что @meta/chrome запущен: cd chrome && bun src/index.ts`);
  }
  const headers: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "image/png", "x-meta-proxied-to": "chrome" };
  const caption = res.headers.get("x-meta-caption");
  if (caption) headers["x-meta-caption"] = caption;
  return new Response(buf, { headers });
}

async function windowResponse(input: WindowCaptureRequest): Promise<Response> {
  if (input.app === undefined || input.app.trim().length === 0)
    return err(400, "missing 'app'", "Укажите имя приложения: {\"app\": \"Google Chrome\"}");

  const app = input.app;
  const index = positiveInt(input.index, 1) ?? 1;
  const delayMs = clamp(nonNegativeInt(input.delayMs, 150) ?? 150, 0, 2_000);
  const restore = input.restore !== false;
  const scale = parseDetail(input.detail ?? (input.scale != null ? String(input.scale) : null));
  const beforeFrontmost = restore ? await frontmostApp() : null;

  if (input.caption) logCaption(input.caption)

  let target: WindowInfo | undefined;
  try {
    const windows = await windowApi.listWindows(app);
    target = selectWindow(windows, index, input.title);
    if (target === undefined) {
      if (app.toLowerCase().includes("chrome")) {
        return await proxyChromeScreenshot(input);
      }
      return err(404, `window not found: app=${app} index=${index}${input.title ? ` title=${input.title}` : ""}`,
        `Проверьте: 1) приложение открыто, 2) разрешение Accessibility выдано (GET http://localhost:7878/permissions/accessibility)`);
    }

    await windowApi.raise(app, target.index);
    if (delayMs > 0) await sleep(delayMs);

    const image = await captureRect(target, { shadow: input.shadow, scale });
    const restored = await restoreFocus(windowApi, beforeFrontmost, restore);
    if (input.format === "json") {
      return json({
        ok: true,
        target: "window",
        mime: "image/png",
        window: target,
        restored,
        ...(input.caption ? { caption: input.caption } : {}),
        base64: Buffer.from(image).toString("base64"),
      });
    }
    const extraHeaders: Record<string, string> = {};
    if (input.caption) extraHeaders["x-meta-caption"] = encodeURIComponent(input.caption);
    return png(image, {
      "x-meta-screen-target": "window",
      "x-meta-window-app": target.app,
      "x-meta-window-index": String(target.index),
      "x-meta-window-title": encodeURIComponent(target.title),
      "x-meta-window-restored": restored.ok ? "true" : "false",
      ...extraHeaders,
    });
  } catch (e) {
    await restoreFocus(windowApi, beforeFrontmost, restore);
    throw e;
  }
}

function selectWindow(windows: WindowInfo[], index: number, title: string | undefined): WindowInfo | undefined {
  if (title !== undefined && title.length > 0) {
    const needle = title.toLowerCase();
    const byTitle = windows.find((w) => w.title.toLowerCase().includes(needle));
    if (byTitle !== undefined) return byTitle;
  }
  return windows.find((w) => w.index === index);
}

async function restoreFocus(api: WindowApi, app: string | null, enabled: boolean): Promise<{ ok: boolean; app: string | null; error?: string }> {
  if (!enabled || app === null) return { ok: true, app };
  try {
    await api.focus(app);
    return { ok: true, app };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, app, error: msg };
  }
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.trim().length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function parseFormat(value: string | null): "png" | "json" {
  return value === "json" ? "json" : "png";
}


async function rectResponse(input: RectCaptureRequest): Promise<Response> {
  const { x, y, width, height } = input;
  if (x == null || y == null || width == null || height == null)
    return err(400, "need {x, y, width, height}");

  const delayMs = clamp(nonNegativeInt(input.delayMs, 150) ?? 150, 0, 2_000);
  const restore = input.restore !== false;
  const scale = parseDetail(input.detail ?? (input.scale != null ? String(input.scale) : null));
  const beforeFrontmost = restore ? await frontmostApp() : null;

  if (input.caption) logCaption(input.caption)

  try {
    if (input.app) await osa(`tell application ${quote(input.app)} to activate`);
    if (delayMs > 0) await sleep(delayMs);

    const image = await captureRect({ x, y, width, height }, { shadow: input.shadow, scale });
    const restored = await restoreFocus(windowApi, beforeFrontmost, restore);

    if (input.format === "json") {
      return json({
        ok: true,
        target: "rect",
        mime: "image/png",
        rect: { x, y, width, height },
        restored,
        ...(input.caption ? { caption: input.caption } : {}),
        base64: Buffer.from(image).toString("base64"),
      });
    }
    const extraHeaders: Record<string, string> = {};
    if (input.caption) extraHeaders["x-meta-caption"] = encodeURIComponent(input.caption);
    return png(image, {
      "x-meta-screen-target": "rect",
      "x-meta-rect": `${x},${y},${width},${height}`,
      "x-meta-window-restored": restored.ok ? "true" : "false",
      ...extraHeaders,
    });
  } catch (e) {
    await restoreFocus(windowApi, beforeFrontmost, restore);
    throw e;
  }
}

async function checkScreenRecording(): Promise<{ granted: boolean; error?: string }> {
  try {
    await captureRect({ x: 0, y: 0, width: 1, height: 1 });
    return { granted: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { granted: false, error: msg };
  }
}
