import { captureDesktop, captureRect, type CaptureOptions } from "./capture.ts";
import { frontmostApp } from "./restore.ts";
import { createWindowApi, type WindowApi, type WindowInfo } from "./window-api.ts";

const PORT = Number(Bun.env.PORT ?? Bun.env.SCREEN_PORT ?? 7879);
const windowApi = createWindowApi();

type WindowCaptureRequest = {
  app?: string;
  index?: number;
  title?: string;
  restore?: boolean;
  delayMs?: number;
  shadow?: boolean;
  format?: "png" | "json";
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function png(data: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(data, {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    try {
      if (path === "/health") {
        return await health();
      }

      if (path === "/desktop" && method === "GET") {
        const display = positiveInt(url.searchParams.get("display"), undefined);
        const format = parseFormat(url.searchParams.get("format"));
        return await desktopResponse({ display }, format);
      }

      if (path === "/desktop" && method === "POST") {
        const body = await readJson<{ display?: number; format?: "png" | "json" }>(req);
        return await desktopResponse({ display: positiveInt(body.display, undefined) }, body.format ?? "png");
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
        };
        return await windowResponse(request);
      }

      if (path === "/window" && method === "POST") {
        return await windowResponse(await readJson<WindowCaptureRequest>(req));
      }

      return err(404, `${method} ${path} not found`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(500, msg);
    }
  },
});

console.log(`@meta/screen listening on http://localhost:${server.port}`);
console.log(`  GET  /health`);
console.log(`  GET  /desktop[?display=1][&format=png|json]`);
console.log(`  POST /desktop { display?, format? }`);
console.log(`  GET  /windows[?app=Name]`);
console.log(`  GET  /window?app=Google%20Chrome[&index=1][&restore=true][&format=png|json]`);
console.log(`  POST /window { app, index?, title?, restore?, delayMs?, shadow?, format? }`);
console.log(`  WINDOW_API=${windowApi.baseUrl}`);

async function health(): Promise<Response> {
  try {
    const upstream = await windowApi.health();
    return json({ ok: true, windowApi: windowApi.baseUrl, window: upstream });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: true, windowApi: windowApi.baseUrl, window: { ok: false, error: msg } });
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

async function windowResponse(input: WindowCaptureRequest): Promise<Response> {
  if (input.app === undefined || input.app.trim().length === 0) return err(400, "missing 'app'");

  const app = input.app;
  const index = positiveInt(input.index, 1) ?? 1;
  const delayMs = clamp(nonNegativeInt(input.delayMs, 150) ?? 150, 0, 2_000);
  const restore = input.restore !== false;
  const beforeFrontmost = restore ? await frontmostApp() : null;

  let target: WindowInfo | undefined;
  try {
    const windows = await windowApi.listWindows(app);
    target = selectWindow(windows, index, input.title);
    if (target === undefined) {
      return err(404, `window not found: app=${app} index=${index}${input.title ? ` title=${input.title}` : ""}`);
    }

    await windowApi.raise(app, target.index);
    if (delayMs > 0) await sleep(delayMs);

    const image = await captureRect(target, { shadow: input.shadow });
    const restored = await restoreFocus(windowApi, beforeFrontmost, restore);
    if (input.format === "json") {
      return json({
        ok: true,
        target: "window",
        mime: "image/png",
        window: target,
        restored,
        base64: Buffer.from(image).toString("base64"),
      });
    }
    return png(image, {
      "x-meta-screen-target": "window",
      "x-meta-window-app": target.app,
      "x-meta-window-index": String(target.index),
      "x-meta-window-title": encodeURIComponent(target.title),
      "x-meta-window-restored": restored.ok ? "true" : "false",
    });
  } catch (e) {
    await restoreFocus(windowApi, beforeFrontmost, restore);
    throw e;
  }
}

function selectWindow(windows: WindowInfo[], index: number, title: string | undefined): WindowInfo | undefined {
  if (title !== undefined && title.length > 0) {
    const needle = title.toLowerCase();
    return windows.find((w) => w.title.toLowerCase().includes(needle));
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

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function nonNegativeInt(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
