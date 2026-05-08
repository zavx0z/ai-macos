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

const PORT = Number(Bun.env.PORT ?? 7880);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(v: string | null): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

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
        return json({ ok: true, running: await isRunning() });
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
        if (!body.url) return err(400, "missing 'url'");
        await navigate(body.url, body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/activate" && method === "POST") {
        const body = (await req.json()) as { windowId?: number; tabIndex?: number };
        if (body.windowId == null || body.tabIndex == null) {
          return err(400, "need {windowId, tabIndex}");
        }
        await activateTab(body.windowId, body.tabIndex);
        return json({ ok: true });
      }

      if (path === "/reload" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { windowId?: number; tabIndex?: number; hard?: boolean };
        if (body.hard) {
          await hardReload(body.windowId, body.tabIndex);
        } else {
          await reload(body.windowId, body.tabIndex);
        }
        return json({ ok: true, hard: body.hard === true });
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
        if (!body.js) return err(400, "missing 'js'");
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
            };
        const result = await screenshotTab(opts as Parameters<typeof screenshotTab>[0]);
        return new Response(result.body, {
          headers: { "content-type": result.contentType, "cache-control": "no-store" },
        });
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

console.log(`@meta/chrome listening on http://localhost:${server.port}`);
console.log(`  GET  /health`);
console.log(`  GET  /windows                              list windows + tabs`);
console.log(`  POST /windows         { url?, incognito? } open new window`);
console.log(`  DEL  /windows/:id                          close window`);
console.log(`  GET  /tabs[?windowId=N]                    list tabs`);
console.log(`  GET  /tabs/active                          info on active tab`);
console.log(`  POST /tabs            { windowId?, url? }  open new tab`);
console.log(`  DEL  /tabs/:wid/:idx                       close tab`);
console.log(`  POST /navigate        { url, windowId?, tabIndex? }`);
console.log(`  POST /activate        { windowId, tabIndex }`);
console.log(`  POST /reload   { windowId?, tabIndex?, hard? }   hard=true → Cmd+Shift+R (steals focus)`);
console.log(`  POST /back | /forward   { windowId?, tabIndex? }`);
console.log(`  POST /eval            { js, windowId?, tabIndex? }   needs "Allow JS from Apple Events"`);
console.log(`  GET  /source[?windowId=N&tabIndex=N]       outerHTML of <html>`);
console.log(`  GET  /text[?windowId=N&tabIndex=N]         document.body.innerText`);
console.log(`  GET  /screenshot[?windowId=N&tabIndex=N&shadow=false&delayMs=200&format=png|json]`);
console.log(`  POST /screenshot { windowId?, tabIndex?, shadow?, delayMs?, format?, restore? }`);
