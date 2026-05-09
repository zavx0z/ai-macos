import {
  activateTab,
  closeTab,
  closeWindow,
  evalJs,
  getActiveTab,
  getSource,
  getText,
  goBack,
  goForward,
  hardReload,
  isRunning,
  listWindows,
  navigate,
  newTab,
  newWindow,
  reload,
  screenshotTab,
} from "./chrome.ts";
import { err, json, logRequest, num, parseBool, printBanner } from "@meta/shared";
import { detectCdp } from "./cdp-mode.ts";

const PORT = Number(Bun.env.PORT ?? 7880);

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
        const cdp = await detectCdp();
        return json({ ok: true, running: await isRunning(), cdp });
      }

      if (path === "/cdp" && method === "GET") {
        return json(await detectCdp(true));
      }

      if (path === "/windows" && method === "GET") {
        const wins = await listWindows();
        return json({ count: wins.length, windows: wins });
      }

      if (path === "/windows" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { url?: string; incognito?: boolean };
        const w = await newWindow({ url: body.url, incognito: body.incognito });
        return json({ ok: true, window: w });
      }

      const winMatch = path.match(/^\/windows\/(\d+)$/);
      if (winMatch && method === "DELETE") {
        await closeWindow(Number(winMatch[1]));
        return json({ ok: true });
      }

      if (path === "/tabs" && method === "GET") {
        const wins = await listWindows();
        const wid = num(url.searchParams.get("windowId"));
        const tabs = wid == null
          ? wins.flatMap((w) => w.tabs.map((t) => ({ ...t, windowId: w.id })))
          : (wins.find((w) => w.id === wid)?.tabs.map((t) => ({ ...t, windowId: wid })) ?? []);
        return json({ count: tabs.length, tabs });
      }

      if (path === "/tabs/active" && method === "GET") {
        const t = await getActiveTab();
        if (!t) return err(404, "no active tab");
        return json(t);
      }

      if (path === "/tabs" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; url?: string };
        const t = await newTab({ windowId: body.windowId, url: body.url });
        return json({ ok: true, tab: t });
      }

      const tabMatch = path.match(/^\/tabs\/(\d+)\/(\d+)$/);
      if (tabMatch && method === "DELETE") {
        await closeTab(Number(tabMatch[1]), Number(tabMatch[2]));
        return json({ ok: true });
      }

      if (path === "/navigate" && method === "POST") {
        const body = (await req.json()) as { url?: string; windowId?: number; tabIndex?: number };
        if (!body.url) return err(400, "missing 'url'", "Пример: {\"url\":\"https://example.com\"}");
        const result = await navigate(body.url, body.windowId, body.tabIndex);
        return json({ ok: true, via: result.via });
      }

      if (path === "/activate" && method === "POST") {
        const body = (await req.json()) as { windowId?: number; tabIndex?: number };
        if (body.windowId == null || body.tabIndex == null) {
          return err(400, "need {windowId, tabIndex}", "Получите windowId из GET /windows, tabIndex — из списка tabs");
        }
        await activateTab(body.windowId, body.tabIndex);
        return json({ ok: true, windowId: body.windowId, tabIndex: body.tabIndex });
      }

      if (path === "/reload" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number; hard?: boolean; wait?: boolean };
        const wait = body.wait !== false;
        const result = body.hard
          ? await hardReload(body.windowId, body.tabIndex, wait)
          : await reload(body.windowId, body.tabIndex, wait);
        return json({ ok: true, hard: body.hard === true, waited: wait, ...result });
      }

      if (path === "/back" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number };
        await goBack(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/forward" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number };
        await goForward(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/eval" && method === "POST") {
        const body = (await req.json()) as { js?: string; windowId?: number; tabIndex?: number };
        if (!body.js) return err(400, "missing 'js'", "Пример: {\"js\":\"return document.title\"}");
        const result = await evalJs(body.js, body.windowId, body.tabIndex);
        return json({ ok: true, result });
      }

      if (path === "/source" && method === "GET") {
        const wid = num(url.searchParams.get("windowId"));
        const tIdx = num(url.searchParams.get("tabIndex"));
        const html = await getSource(wid, tIdx);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (path === "/text" && method === "GET") {
        const wid = num(url.searchParams.get("windowId"));
        const tIdx = num(url.searchParams.get("tabIndex"));
        const text = await getText(wid, tIdx);
        return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      if (path === "/screenshot" && (method === "GET" || method === "POST")) {
        const opts = method === "POST"
          ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
          : {
              windowId: num(url.searchParams.get("windowId")),
              tabIndex: num(url.searchParams.get("tabIndex")),
              shadow: parseBool(url.searchParams.get("shadow")),
              delayMs: num(url.searchParams.get("delayMs")),
              format: (url.searchParams.get("format") === "json" ? "json" : "png") as "png" | "json",
              restore: parseBool(url.searchParams.get("restore")),
              caption: url.searchParams.get("caption") ?? undefined,
            };
        const result = await screenshotTab(opts as Parameters<typeof screenshotTab>[0]);
        const headers: Record<string, string> = { "content-type": result.contentType, "cache-control": "no-store" };
        if (result.caption) headers["x-meta-caption"] = encodeURIComponent(result.caption);
        return new Response(result.body, { headers });
      }

      return err(404, `${method} ${path} not found`, "Доступные маршруты: GET /health /windows /tabs /tabs/active /source /text /screenshot, POST /windows /tabs /navigate /activate /reload /back /forward /eval /screenshot, DELETE /windows/:id /tabs/:wid/:idx");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let hint: string | undefined;
      if (msg.includes("-1743") || msg.includes("not authorized to send Apple events")) {
        hint = "Нет разрешения Automation для Chrome. Выдайте в System Settings → Privacy → Automation";
      } else if (msg.includes("JavaScript") && msg.includes("Apple Events")) {
        hint = "Включите View → Developer → Allow JavaScript from Apple Events в Chrome";
      } else if (msg.includes("screen api")) {
        hint = "Сервис @meta/screen недоступен. Убедитесь что он запущен: cd screen && bun src/index.ts";
      }
      return err(500, msg, hint);
    }
    })();
    logRequest(method, path, res.status, Math.round(performance.now() - t0));
    return res;
  },
});

printBanner("@meta/chrome", PORT, [
  { routes: [
    { method: "GET", path: "/health", description: "состояние Chrome, CDP и сервиса" },
    { method: "GET", path: "/cdp",    description: "проверить CDP (--remote-debugging-port)" },
  ]},
  { title: "Окна и вкладки", routes: [
    { method: "GET",    path: "/windows",        description: "список окон с вкладками" },
    { method: "POST",   path: "/windows",        description: "открыть окно" },
    { method: "DELETE", path: "/windows/:id",    description: "закрыть окно" },
    { method: "GET",    path: "/tabs",           description: "список вкладок" },
    { method: "GET",    path: "/tabs/active",    description: "активная вкладка" },
    { method: "POST",   path: "/tabs",           description: "открыть вкладку" },
    { method: "DELETE", path: "/tabs/:wid/:idx", description: "закрыть вкладку" },
  ]},
  { title: "Навигация", routes: [
    { method: "POST", path: "/navigate", description: "перейти по URL" },
    { method: "POST", path: "/activate", description: "активировать вкладку" },
    { method: "POST", path: "/reload",   description: "перезагрузить  ({hard?,wait?}) — ждёт загрузки" },
    { method: "POST", path: "/back",     description: "назад" },
    { method: "POST", path: "/forward",  description: "вперёд" },
  ]},
  { title: "Контент", routes: [
    { method: "POST", path: "/eval",   description: "выполнить JS в вкладке" },
    { method: "GET",  path: "/source", description: "HTML страницы" },
    { method: "GET",  path: "/text",   description: "текст страницы" },
  ]},
  { title: "Скриншот", routes: [
    { method: "GET",  path: "/screenshot", description: "скриншот вкладки  (?detail=low|medium|high|full&caption=)" },
    { method: "POST", path: "/screenshot", description: "скриншот вкладки  ({detail?,scale?,caption?})" },
  ]},
]);
