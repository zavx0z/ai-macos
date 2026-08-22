const port = Number(process.env.AI_MACOS_SAFARI_FIXTURE_PORT ?? 18999)
let count = 0

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ ok: true, count })
    count++
    const title = `ai-macos-reload-count:${count}`
    return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>ai-macos Safari reload fixture</h1><p id="count">${title}</p></main></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    })
  },
})

console.log(`Safari reload fixture: http://127.0.0.1:${port}/`)
console.log("Open that URL in exactly one visible Safari window before running test:safari-e2e.")
