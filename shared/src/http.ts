export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export function png(data: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(data, {
    headers: { "content-type": "image/png", "cache-control": "no-store", ...headers },
  });
}
