export type WindowInfo = {
  app: string
  pid: number
  title: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

export type WindowTarget = {
  app: string
  pid?: number
  index?: number
  title?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

export type FrontmostWindow = {
  app: string
  pid: number
  window: WindowInfo | null
}

export type WindowApi = {
  baseUrl: string
  health(): Promise<{ ok: boolean; service?: string; [key: string]: unknown }>
  listWindows(app?: string): Promise<WindowInfo[]>
  frontmost(): Promise<FrontmostWindow>
  focus(target: WindowTarget): Promise<void>
  raise(target: WindowInfo): Promise<void>
}

export function createWindowApi(
  baseUrl = Bun.env.WINDOW_API ?? "http://localhost:7878",
): WindowApi {
  const base = baseUrl.replace(/\/+$/, "")

  return {
    baseUrl: base,

    async health(): Promise<{ ok: boolean; service?: string; [key: string]: unknown }> {
      return await getJson<{ ok: boolean; service?: string; [key: string]: unknown }>(base, "/health")
    },

    async listWindows(app?: string): Promise<WindowInfo[]> {
      const query = app === undefined ? "" : `?app=${encodeURIComponent(app)}`
      const payload = await getJson<{ count: number; windows: WindowInfo[] }>(base, `/windows${query}`)
      return payload.windows
    },

    async frontmost(): Promise<FrontmostWindow> {
      return await getJson<FrontmostWindow>(base, "/frontmost")
    },

    async focus(target): Promise<void> {
      await postJson(base, "/focus", target)
    },

    async raise(target): Promise<void> {
      await postJson(base, "/raise", {
        app: target.app,
        pid: target.pid,
        index: target.index,
      })
    },
  }
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`)
  const body = await response.json()
  if (!response.ok) throw new Error(jsonError(body))
  return body as T
}

async function postJson(base: string, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(jsonError(await response.json()))
}

function jsonError(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String((body as { error: unknown }).error)
  }
  return JSON.stringify(body)
}
