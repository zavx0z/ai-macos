export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';

export function err(status: number, message: string, hint?: string): Response {
  const body: Record<string, string> = { error: message };
  if (hint) body.hint = hint;
  console.error(`  ${RED}ERR${R}  ${message}${hint ? `\n  ${DIM}↳ ${hint}${R}` : ''}`);
  return json(body, { status });
}

export function png(data: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(data, {
    headers: { "content-type": "image/png", "cache-control": "no-store", ...headers },
  });
}
