export type WindowInfo = {
  app: string;
  pid: number;
  title: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowApi = {
  baseUrl: string;
  health(): Promise<{ ok: true }>;
  listWindows(app?: string): Promise<WindowInfo[]>;
  focus(app: string): Promise<void>;
  raise(app: string, index: number): Promise<void>;
};

export function createWindowApi(baseUrl = Bun.env.WINDOW_API ?? "http://localhost:7878"): WindowApi {
  const base = baseUrl.replace(/\/+$/, "");

  return {
    baseUrl: base,

    async health(): Promise<{ ok: true }> {
      return await getJson<{ ok: true }>(base, "/health");
    },

    async listWindows(app?: string): Promise<WindowInfo[]> {
      const query = app === undefined ? "" : `?app=${encodeURIComponent(app)}`;
      const payload = await getJson<{ count: number; windows: WindowInfo[] }>(base, `/windows${query}`);
      return payload.windows;
    },

    async focus(app: string): Promise<void> {
      await postJson(base, "/focus", { app });
    },

    async raise(app: string, index: number): Promise<void> {
      await postJson(base, "/raise", { app, index });
    },
  };
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(jsonError(body));
  return body as T;
}

async function postJson(base: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(jsonError(await res.json()));
}

function jsonError(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return JSON.stringify(body);
}
