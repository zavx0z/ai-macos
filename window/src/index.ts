import { checkAccessibility, focusApplication, focusWindow, getFrontmostState, getScreen, listWindows, moveWindow, raiseWindow, requestAccessibility, resizeWindow } from "./windows.ts"
import { isFocusedSheet } from "./focus.ts"
import { listPins, startPin, stopAllPins, stopPin } from "./pin.ts";
import { err, json, logRequest, printBanner, selectUniqueWindow, matchesWindow, sameWindowIdentity, stableWindowTarget, validWindowId } from "@meta/shared";

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
      if (path === "/health") {
        const accessibility = await checkAccessibility()
        return json({
          ok: accessibility.granted,
          service: "@meta/window",
          backend: "meta-input-helper",
          capabilities: { stableWindowId: true },
          accessibility,
        })
      }

      if (path === "/screen" && method === "GET") {
        return json(await getScreen());
      }

      if (path === "/windows" && method === "GET") {
        const all = await listWindows();
        const app = url.searchParams.get("app");
        const filtered = app ? all.filter((w) => w.app.toLowerCase() === app.toLowerCase()) : all;
        return json({ count: filtered.length, windows: filtered });
      }

      if (path === "/frontmost" && method === "GET") {
        return json(await getFrontmostState())
      }

      if (path === "/focus" && method === "POST") {
        const body = (await req.json()) as {
          app?: string;
          pid?: number;
          windowId?: number;
          index?: number;
          title?: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        };
        if (!body.app) return err(400, "missing 'app'", "Укажите имя процесса macOS: {\"app\": \"Google Chrome\"}");
        const previousFrontmost = await getFrontmostState()
        const previousWindow = previousFrontmost.window
        if (body.windowId !== undefined && !validWindowId(body.windowId)) return err(400, "invalid windowId")
        const windows = (await listWindows()).filter(window => matchesWindow(window, body));
        if (windows.length === 0) {
          return err(
            404,
            `visible window not found: app=${body.app}${body.pid ? ` pid=${body.pid}` : ""}${body.windowId ? ` windowId=${body.windowId}` : ""}${body.index ? ` index=${body.index}` : ""}${body.title ? ` title=${body.title}` : ""}`,
            "Сначала вызовите GET /windows и используйте точные app/pid/index. Никакое приложение не было запущено и фокус не менялся.",
          );
        }
        if (windows.length > 1) {
          const candidates = windows.map(({ app, pid, windowId, index, title }) => ({ app, pid, windowId, index, title }));
          return err(
            409,
            `ambiguous window target: ${windows.length} windows match ${body.app}`,
            `Укажите pid и index ровно одного окна из GET /windows: ${JSON.stringify(candidates)}`,
          );
        }
        const target = windows[0]!;

        const alreadyFocused = previousWindow
          && (sameWindowIdentity(target, previousWindow) || isFocusedSheet(target, previousWindow))
        if (!alreadyFocused) {
          await raiseWindow(target.app, target.index, target.pid, target.windowId)
          await focusWindow(target)
        }
        let frontmost = await getFrontmostState()
        // Preserve an existing menu/field focus. If another application took
        // focus after the passive snapshot, explicitly activate the target once.
        if (alreadyFocused && frontmost.pid !== target.pid) {
          await raiseWindow(target.app, target.index, target.pid, target.windowId)
          await focusWindow(target)
          frontmost = await getFrontmostState()
        }
        for (let attempt = 0; attempt < 5 && frontmost.pid !== target.pid; attempt += 1) {
          await Bun.sleep(40)
          frontmost = await getFrontmostState()
        }
        if (frontmost.pid !== target.pid) {
          return err(
            409,
            `focus verification failed: expected ${target.app} pid=${target.pid}, got ${frontmost.app} pid=${frontmost.pid}`,
            "Клавиатурный или мышиный ввод после этого ответа выполнять нельзя.",
          );
        }
        const focusedWindow = frontmost.window
        const targetMatchesFocusedWindow = focusedWindow && sameWindowIdentity(target, focusedWindow)
        const targetOwnsFocusedSheet = focusedWindow && isFocusedSheet(target, focusedWindow)
        const targetHasUnreportedModal = !validWindowId(target.windowId) && !focusedWindow
          && previousFrontmost.app.toLowerCase() === target.app.toLowerCase()
          && previousFrontmost.pid === target.pid
          && frontmost.app.toLowerCase() === target.app.toLowerCase()
          && frontmost.pid === target.pid
        if (!targetMatchesFocusedWindow && !targetOwnsFocusedSheet && !targetHasUnreportedModal) {
          if (previousWindow) {
            const previousSelector = validWindowId(previousWindow.ownerWindowId)
              ? { app: previousWindow.app, pid: previousWindow.pid, windowId: previousWindow.ownerWindowId }
              : stableWindowTarget(previousWindow)
            const previousNow = (await listWindows()).find(window => matchesWindow(window, previousSelector));
            if (previousNow) {
              await raiseWindow(previousNow.app, previousNow.index, previousNow.pid, previousNow.windowId)
              await focusWindow(previousNow)
            }
          } else {
            await focusApplication(previousFrontmost.pid)
          }
          return err(
            409,
            `focused-window verification failed for ${target.app} pid=${target.pid} index=${target.index}`,
            "Фокус предыдущего окна восстановлен; ввод выполнять нельзя.",
          );
        }
        const verifiedTarget = validWindowId(target.windowId)
          ? selectUniqueWindow(await listWindows(), stableWindowTarget(target))
          : target
        if (!verifiedTarget) return err(409, "target window disappeared before input; rediscover windows")
        return json({
          ok: true,
          target: verifiedTarget,
          frontmost: { ...frontmost, window: focusedWindow },
          focusedSheet: targetOwnsFocusedSheet ? focusedWindow : null,
          unreportedModal: targetHasUnreportedModal,
          previous: { ...previousFrontmost, window: previousWindow },
        });
      }

      if (path === "/move" && method === "POST") {
        const body = (await req.json()) as { app?: string, pid?: number, windowId?: number, index?: number, x?: number, y?: number }
        if (!body.app || body.x == null || body.y == null)
          return err(400, "need {app, x, y, index?}", "Пример: {\"app\":\"iTerm2\",\"x\":0,\"y\":0}");
        await moveWindow(body.app, body.index ?? 1, body.x, body.y, body.pid, body.windowId)
        return json({ ok: true });
      }

      if (path === "/resize" && method === "POST") {
        const body = (await req.json()) as { app?: string, pid?: number, windowId?: number, index?: number, width?: number, height?: number }
        if (!body.app || body.width == null || body.height == null)
          return err(400, "need {app, width, height, index?}", "Пример: {\"app\":\"iTerm2\",\"width\":960,\"height\":600}");
        await resizeWindow(body.app, body.index ?? 1, body.width, body.height, body.pid, body.windowId)
        return json({ ok: true });
      }

      if (path === "/arrange" && method === "POST") {
        const body = (await req.json()) as {
          app?: string;
          pid?: number
          windowId?: number
          index?: number;
          preset?: "left" | "right" | "top" | "bottom" | "max" | "center";
        };
        if (!body.app || !body.preset)
          return err(400, "need {app, preset}", "Пресеты: left | right | top | bottom | max | center");
        const target = selectUniqueWindow(await listWindows(), { app: body.app, pid: body.pid, windowId: body.windowId, index: body.index ?? 1 })
        if (!target) return err(404, "visible arrange target not found")
        const screen = await getScreen();
        const idx = target.index;
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
        if (!p) return err(400, `unknown preset '${body.preset}'`, "Доступные пресеты: left | right | top | bottom | max | center");
        await moveWindow(target.app, idx, p[0], p[1], target.pid, target.windowId)
        await resizeWindow(target.app, idx, p[2], p[3], target.pid, target.windowId)
        return json({ ok: true, applied: { x: p[0], y: p[1], width: p[2], height: p[3] } });
      }

      if (path === "/raise" && method === "POST") {
        const body = (await req.json()) as { app?: string, pid?: number, windowId?: number, index?: number }
        if (!body.app) return err(400, "missing 'app'", "Укажите имя процесса macOS: {\"app\": \"Google Chrome\"}");
        await raiseWindow(body.app, body.index ?? 1, body.pid, body.windowId)
        return json({ ok: true });
      }

      if (path === "/pin" && method === "GET") {
        return json({ pins: listPins() });
      }

      if (path === "/pin" && method === "POST") {
        const body = (await req.json()) as { app?: string; pid?: number; windowId?: number; index?: number; intervalMs?: number };
        if (!body.app) return err(400, "missing 'app'", "Пример: {\"app\":\"iTerm2\",\"intervalMs\":500}");
        const interval = body.intervalMs ?? 500;
        if (interval < 100) return err(400, "intervalMs must be >= 100", "Минимальный интервал 100 мс чтобы не перегружать систему");
        const pin = await startPin(body.app, body.index ?? 1, interval, body.pid, body.windowId);
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
        return json(await requestAccessibility())
      }

      return err(404, `${method} ${path} not found`, "Доступные маршруты: GET /health /screen /windows /frontmost /pin, POST /focus /move /resize /arrange /raise /pin, DELETE /pin /pin/:id");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAccessibility = msg.includes("-25211") || msg.includes("osascript failed (1)");
      return err(500, msg, isAccessibility ? "Нет разрешения Accessibility. Выдайте его в POST http://localhost:7878/permissions/accessibility" : undefined);
    }
    })();
    logRequest(method, path, res.status, Math.round(performance.now() - t0));
    return res;
  },
});

printBanner("@meta/window", PORT, [
  { routes: [
    { method: "GET", path: "/health", description: "состояние сервиса" },
  ]},
  { title: "Экран и окна", routes: [
    { method: "GET",  path: "/screen",       description: "размер дисплея" },
    { method: "GET",  path: "/windows",      description: "список окон" },
    { method: "GET",  path: "/frontmost",    description: "проверить активное приложение" },
    { method: "POST", path: "/focus",        description: "переключить фокус только на видимое окно и проверить" },
    { method: "POST", path: "/move",         description: "переместить окно" },
    { method: "POST", path: "/resize",       description: "изменить размер" },
    { method: "POST", path: "/arrange",      description: "расположить  (left|right|top|bottom|max|center)" },
    { method: "POST", path: "/raise",        description: "поднять без фокуса" },
  ]},
  { title: "Поверх других окон", routes: [
    { method: "POST",   path: "/pin",      description: "закрепить окно поверх" },
    { method: "GET",    path: "/pin",      description: "список закреплённых окон" },
    { method: "DELETE", path: "/pin/:id",  description: "снять закрепление" },
    { method: "DELETE", path: "/pin",      description: "снять все закрепления" },
  ]},
  { title: "Разрешения", routes: [
    { method: "GET",  path: "/permissions/accessibility", description: "проверить Accessibility" },
    { method: "POST", path: "/permissions/accessibility", description: "открыть Настройки → Конфиденциальность" },
  ]},
]);
