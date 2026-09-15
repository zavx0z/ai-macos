#!/usr/bin/env bun
export {};

const BASE = Bun.env.SCREEN_API ?? "http://localhost:7879";

type Args = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = "", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next != null && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = "true";
    }
  }
  return { cmd, args };
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function savePng(path: string, output: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(JSON.stringify(await res.json()));
  await Bun.write(output, await res.arrayBuffer());
}

function help(): never {
  console.log(`screen - REST CLI for @meta/screen (base: ${BASE})

usage:
  screen health
  screen windows [--app "Google Chrome"]
  screen desktop --out /tmp/desktop.png [--display 1]
  screen window  --app "Google Chrome" --out /tmp/chrome.png [--index 1] [--title text] [--restore true]

env:
  SCREEN_API  override screen API base (default http://localhost:7879)
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
      console.log(JSON.stringify(await getJson("/health"), null, 2));
      break;

    case "windows": {
      const q = args.app ? `?app=${encodeURIComponent(args.app)}` : "";
      console.log(JSON.stringify(await getJson(`/windows${q}`), null, 2));
      break;
    }

    case "desktop": {
      if (!args.out) throw new Error("--out required");
      const params = new URLSearchParams();
      if (args.display) params.set("display", args.display);
      await savePng(`/desktop${params.size > 0 ? `?${params}` : ""}`, args.out);
      console.log(JSON.stringify({ ok: true, output: args.out }, null, 2));
      break;
    }

    case "window": {
      if (!args.app) throw new Error("--app required");
      if (!args.out) throw new Error("--out required");
      const params = new URLSearchParams({ app: args.app });
      if (args.index) params.set("index", args.index);
      if (args.title) params.set("title", args.title);
      if (args.restore) params.set("restore", args.restore);
      if (args.delay) params.set("delayMs", args.delay);
      await savePng(`/window?${params}`, args.out);
      console.log(JSON.stringify({ ok: true, output: args.out }, null, 2));
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
