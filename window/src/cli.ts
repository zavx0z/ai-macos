#!/usr/bin/env bun
export {};
const BASE = Bun.env.WINDOW_API ?? "http://localhost:7878";

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

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function help(): never {
  console.log(`window — REST CLI for @meta/window (base: ${BASE})

usage:
  window health
  window screen
  window list [--app "Name"]
  window focus --app "Name"
  window move   --app "Name" --x 0 --y 0 [--index 1]
  window resize --app "Name" --width 1200 --height 800 [--index 1]
  window arrange --app "Name" --preset left|right|top|bottom|max|center [--index 1]
  window raise   --app "Name" [--index 1]
  window pin     --app "Name" [--index 1] [--interval 500]
  window unpin   --id <id>
  window unpin-all
  window pins

env:
  WINDOW_API   override API base (default http://localhost:7878)
`);
  process.exit(0);
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
      console.log(JSON.stringify(await get("/health"), null, 2));
      break;

    case "screen":
      console.log(JSON.stringify(await get("/screen"), null, 2));
      break;

    case "list": {
      const q = args.app ? `?app=${encodeURIComponent(args.app)}` : "";
      console.log(JSON.stringify(await get(`/windows${q}`), null, 2));
      break;
    }

    case "focus": {
      if (!args.app) throw new Error("--app required");
      console.log(JSON.stringify(await post("/focus", { app: args.app }), null, 2));
      break;
    }

    case "move": {
      if (!args.app || args.x == null || args.y == null) throw new Error("--app --x --y required");
      const payload = {
        app: args.app,
        x: Number(args.x),
        y: Number(args.y),
        index: args.index ? Number(args.index) : 1,
      };
      console.log(JSON.stringify(await post("/move", payload), null, 2));
      break;
    }

    case "resize": {
      if (!args.app || args.width == null || args.height == null) throw new Error("--app --width --height required");
      const payload = {
        app: args.app,
        width: Number(args.width),
        height: Number(args.height),
        index: args.index ? Number(args.index) : 1,
      };
      console.log(JSON.stringify(await post("/resize", payload), null, 2));
      break;
    }

    case "arrange": {
      if (!args.app || !args.preset) throw new Error("--app --preset required");
      const payload = {
        app: args.app,
        preset: args.preset,
        index: args.index ? Number(args.index) : 1,
      };
      console.log(JSON.stringify(await post("/arrange", payload), null, 2));
      break;
    }

    case "raise": {
      if (!args.app) throw new Error("--app required");
      console.log(JSON.stringify(await post("/raise", { app: args.app, index: args.index ? Number(args.index) : 1 }), null, 2));
      break;
    }

    case "pin": {
      if (!args.app) throw new Error("--app required");
      const payload = {
        app: args.app,
        index: args.index ? Number(args.index) : 1,
        intervalMs: args.interval ? Number(args.interval) : 500,
      };
      console.log(JSON.stringify(await post("/pin", payload), null, 2));
      break;
    }

    case "pins": {
      console.log(JSON.stringify(await get("/pin"), null, 2));
      break;
    }

    case "unpin": {
      if (!args.id) throw new Error("--id required");
      const res = await fetch(`${BASE}/pin/${encodeURIComponent(args.id)}`, { method: "DELETE" });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }

    case "unpin-all": {
      const res = await fetch(`${BASE}/pin`, { method: "DELETE" });
      console.log(JSON.stringify(await res.json(), null, 2));
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
