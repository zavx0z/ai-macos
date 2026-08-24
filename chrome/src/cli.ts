#!/usr/bin/env bun
export {};
const BASE = Bun.env.CHROME_API ?? "http://localhost:7880";

type Args = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; args: Args; positional: string[] } {
  const [cmd = "", ...rest] = argv;
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next != null && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, args, positional };
}

async function get(path: string, asText = false): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body);
  }
  return asText ? await res.text() : await res.json();
}

async function send(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pretty(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function help(): never {
  console.log(`chrome — REST CLI for @meta/chrome (base: ${BASE})

usage:
  chrome health
  chrome profiles
  chrome session [--profile <directory>]
  chrome windows
  chrome tabs [--window <id>]
  chrome active
  chrome new-window  [--url <url>] [--incognito]
  chrome close-window --window <id>
  chrome new-tab     [--window <id>] [--url <url>]
  chrome close-tab    --window <id> --index <n>
  chrome activate     --window <id> --index <n>
  chrome navigate     --url <url> [--window <id>] [--index <n>]
  chrome reload       [--window <id>] [--index <n>] [--hard]
  chrome back         [--window <id>] [--index <n>]
  chrome forward      [--window <id>] [--index <n>]
  chrome eval         --js "<code>" [--window <id>] [--index <n>]
  chrome source       [--window <id>] [--index <n>]
  chrome text         [--window <id>] [--index <n>]
  chrome screenshot   [--window <id>] [--index <n>] [--out <path>] [--shadow false] [--delayMs 200]

env:
  CHROME_API   override API base (default http://localhost:7880)
`);
  process.exit(0);
}

function targetBody(args: Args): { windowId?: number; tabIndex?: number } {
  const out: { windowId?: number; tabIndex?: number } = {};
  if (args.window) out.windowId = Number(args.window);
  if (args.index) out.tabIndex = Number(args.index);
  return out;
}

const { cmd, args } = parseArgs(Bun.argv.slice(2));

try {
  switch (cmd) {
    case "":
    case "help":
    case "-h":
    case "--help":
      help();

    case "health":
      console.log(pretty(await get("/health")));
      break;

    case "profiles":
      console.log(pretty(await get("/profiles")));
      break;

    case "session":
      console.log(pretty(await send("POST", "/session", args.profile ? {profileDirectory: args.profile} : {})));
      break;

    case "windows":
      console.log(pretty(await get("/windows")));
      break;

    case "tabs": {
      const q = args.window ? `?windowId=${encodeURIComponent(args.window)}` : "";
      console.log(pretty(await get(`/tabs${q}`)));
      break;
    }

    case "active":
      console.log(pretty(await get("/tabs/active")));
      break;

    case "new-window": {
      const body: Record<string, unknown> = {};
      if (args.url) body.url = args.url;
      if (args.incognito) body.incognito = true;
      console.log(pretty(await send("POST", "/windows", body)));
      break;
    }

    case "close-window": {
      if (!args.window) throw new Error("--window required");
      console.log(pretty(await send("DELETE", `/windows/${encodeURIComponent(args.window)}`)));
      break;
    }

    case "new-tab": {
      const body: Record<string, unknown> = {};
      if (args.window) body.windowId = Number(args.window);
      if (args.url) body.url = args.url;
      console.log(pretty(await send("POST", "/tabs", body)));
      break;
    }

    case "close-tab": {
      if (!args.window || !args.index) throw new Error("--window and --index required");
      console.log(pretty(await send("DELETE", `/tabs/${encodeURIComponent(args.window)}/${encodeURIComponent(args.index)}`)));
      break;
    }

    case "activate": {
      if (!args.window || !args.index) throw new Error("--window and --index required");
      console.log(pretty(await send("POST", "/activate", { windowId: Number(args.window), tabIndex: Number(args.index) })));
      break;
    }

    case "navigate": {
      if (!args.url) throw new Error("--url required");
      console.log(pretty(await send("POST", "/navigate", { url: args.url, ...targetBody(args) })));
      break;
    }

    case "reload": {
      const body: Record<string, unknown> = { ...targetBody(args) };
      if (args.hard) body.hard = true;
      console.log(pretty(await send("POST", "/reload", body)));
      break;
    }

    case "back":
      console.log(pretty(await send("POST", "/back", targetBody(args))));
      break;

    case "forward":
      console.log(pretty(await send("POST", "/forward", targetBody(args))));
      break;

    case "eval": {
      if (!args.js) throw new Error("--js required");
      console.log(pretty(await send("POST", "/eval", { js: args.js, ...targetBody(args) })));
      break;
    }

    case "source": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      const qs = params.toString();
      console.log(await get(`/source${qs ? `?${qs}` : ""}`, true));
      break;
    }

    case "text": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      const qs = params.toString();
      console.log(await get(`/text${qs ? `?${qs}` : ""}`, true));
      break;
    }

    case "screenshot": {
      const params = new URLSearchParams();
      if (args.window) params.set("windowId", args.window);
      if (args.index) params.set("tabIndex", args.index);
      if (args.shadow) params.set("shadow", args.shadow);
      if (args.delayMs) params.set("delayMs", args.delayMs);
      const qs = params.toString();
      const res = await fetch(`${BASE}/screenshot${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error(await res.text());
      const buf = new Uint8Array(await res.arrayBuffer());
      const out = args.out ?? `./tmp/screenshots/chrome-${Date.now()}.png`;
      const parent = out.slice(0, out.lastIndexOf("/"));
      if (parent.length > 0) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(parent, { recursive: true });
      }
      await Bun.write(out, buf);
      console.log(JSON.stringify({ ok: true, path: out, bytes: buf.byteLength }, null, 2));
      break;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      help();
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  process.exit(1);
}
