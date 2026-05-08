import { checkAccessibility, focusApp, getScreen, listWindows, moveWindow, raiseWindow, resizeWindow } from "./windows.ts";
import { listPins, startPin, stopAllPins, stopPin } from "./pin.ts";
import { err, json } from "@meta/shared";

const PORT = Number(Bun.env.PORT ?? 7878);

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    const res = await (async () => {
    try {
      if (path === "/health") return json({ ok: true });

      if (path === "/screen" && method === "GET") {
        return json(await getScreen());
      }

      if (path === "/windows" && method === "GET") {
        const all = await listWindows();
        const app = url.searchParams.get("app");
        const filtered = app ? all.filter((w) => w.app.toLowerCase() === app.toLowerCase()) : all;
        return json({ count: filtered.length, windows: filtered });
      }

      if (path === "/focus" && method === "POST") {
        const body = (await req.json()) as { app?: string };
        if (!body.app) return err(400, "missing 'app'");
        await focusApp(body.app);
        return json({ ok: true });
      }

      if (path === "/move" && method === "POST") {
        const body = (await req.json()) as { app?: string; index?: number; x?: number; y?: number };
        if (!body.app || body.x == null || body.y == null) return err(400, "need {app, x, y, index?}");
        await moveWindow(body.app, body.index ?? 1, body.x, body.y);
        return json({ ok: true });
      }

      if (path === "/resize" && method === "POST") {
        const body = (await req.json()) as { app?: string; index?: number; width?: number; height?: number };
        if (!body.app || body.width == null || body.height == null) return err(400, "need {app, width, height, index?}");
        await resizeWindow(body.app, body.index ?? 1, body.width, body.height);
        return json({ ok: true });
      }

      if (path === "/arrange" && method === "POST") {
        const body = (await req.json()) as {
          app?: string;
          index?: number;
          preset?: "left" | "right" | "top" | "bottom" | "max" | "center";
        };
        if (!body.app || !body.preset) return err(400, "need {app, preset}");
        const screen = await getScreen();
        const idx = body.index ?? 1;
        const W = screen.width;
        const H = screen.height;
        const half = Math.floor(W / 2);
        const halfH = Math.floor(H / 2);
        const presets: Record<string, [number, number, number, number]> = {
          left:   [0,    0, half, H],
          right:  [half, 0, half, H],
          top:    [0,    0, W,    halfH],
          bottom: [0,    halfH, W, halfH],
          max:    [0,    0, W,    H],
          center: [Math.floor(W / 4), Math.floor(H / 8), Math.floor(W / 2), Math.floor((H * 3) / 4)],
        };
        const p = presets[body.preset];
        if (!p) return err(400, `unknown preset '${body.preset}'`);
        await moveWindow(body.app, idx, p[0], p[1]);
        await resizeWindow(body.app, idx, p[2], p[3]);
        return json({ ok: true, applied: { x: p[0], y: p[1], width: p[2], height: p[3] } });
      }

      if (path === "/raise" && method === "POST") {
        const body = (await req.json()) as { app?: string; index?: number };
        if (!body.app) return err(400, "missing 'app'");
        await raiseWindow(body.app, body.index ?? 1);
        return json({ ok: true });
      }

      if (path === "/pin" && method === "GET") {
        return json({ pins: listPins() });
      }

      if (path === "/pin" && method === "POST") {
        const body = (await req.json()) as { app?: string; index?: number; intervalMs?: number };
        if (!body.app) return err(400, "missing 'app'");
        const interval = body.intervalMs ?? 500;
        if (interval < 100) return err(400, "intervalMs must be >= 100");
        const pin = startPin(body.app, body.index ?? 1, interval);
        return json({ ok: true, pin });
      }

      if (path.startsWith("/pin/") && method === "DELETE") {
        const id = path.slice("/pin/".length);
        const removed = stopPin(id);
        return json({ ok: removed, removed });
      }

      if (path === "/pin" && method === "DELETE") {
        const n = stopAllPins();
        return json({ ok: true, removed: n });
      }

      if (path === "/permissions/accessibility" && method === "GET") {
        return json(await checkAccessibility());
      }

      if (path === "/permissions/accessibility" && method === "POST") {
        const proc = Bun.spawn(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
        await proc.exited;
        return json({ ...(await checkAccessibility()), opened: true });
      }

      return err(404, `${method} ${path} not found`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(500, msg);
    }
    })();
    console.log(`${method} ${path} → ${res.status} ${Math.round(performance.now() - t0)}ms`);
    return res;
  },
});

console.log(`@meta/window listening on http://localhost:${server.port}`);
console.log(`  GET  /health`);
console.log(`  GET  /screen`);
console.log(`  GET  /windows[?app=Name]`);
console.log(`  POST /focus    { app }`);
console.log(`  POST /move     { app, x, y, index? }`);
console.log(`  POST /resize   { app, width, height, index? }`);
console.log(`  POST /arrange  { app, preset, index? }   preset: left|right|top|bottom|max|center`);
console.log(`  POST /raise    { app, index? }            one-shot AXRaise (no focus steal)`);
console.log(`  POST /pin      { app, index?, intervalMs? } start "soft topmost" loop`);
console.log(`  GET  /pin                                  list active pins`);
console.log(`  DEL  /pin/:id  | DEL /pin                  stop one / all pins`);
console.log(`  GET  /permissions/accessibility             check Accessibility permission`);
console.log(`  POST /permissions/accessibility             open System Settings → Accessibility`);
