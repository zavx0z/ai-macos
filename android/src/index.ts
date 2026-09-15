import { err, json, logRequest, printBanner } from "@meta/shared"

const PORT = Number(Bun.env.PORT ?? 7881)

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(request) {
    const startedAt = performance.now()
    const url = new URL(request.url)
    const response = url.pathname === "/health" && request.method === "GET"
      ? json({
          ok: true,
          service: "@meta/android",
          profile: "android.chrome",
          adb: "unknown",
          devices: [],
          capability: {
            id: "android.chrome",
            state: "unavailable",
            reason: "connected-adapter-unavailable",
          },
        })
      : err(
          503,
          "android.chrome legacy service is disabled",
          "Дождитесь подключения принятого AndroidChromeAdapter через общий runtime; fallback на общий port 9223 запрещён",
        )
    logRequest(request.method, url.pathname, response.status, Math.round(performance.now() - startedAt))
    return response
  },
})

printBanner("@meta/android", PORT, [
  {
    routes: [
      { method: "GET", path: "/health", description: "пассивный unavailable-статус opt-in профиля" },
    ],
  },
])

console.log("  Legacy Android REST actions выключены до подключения runtime-owned AndroidChromeAdapter")
