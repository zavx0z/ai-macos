import { err, json, logRequest, num, printBanner } from "@meta/shared"
import {
  bootstrap,
  probeAccessibilityNow,
  requestAccessibilityNow,
  type InputBootstrapStatus,
} from "./bootstrap.ts"
import { NativeInputError } from "./native.ts"
import { click, drag, getPosition, move, scroll, setNativeHelper } from "./mouse.ts"
import {
  pressKey,
  pressShortcut,
  pressShortcuts,
  setKeyboardNativeHelper,
  typeText,
} from "./keyboard.ts"

const PORT = Number(Bun.env.PORT ?? 7882)
const AUTO_REQUEST_ACCESSIBILITY = Bun.env.INPUT_AUTO_REQUEST_ACCESSIBILITY !== "false"

let bootStatus: InputBootstrapStatus = await bootstrap(AUTO_REQUEST_ACCESSIBILITY)
setNativeHelper(bootStatus.helper)
setKeyboardNativeHelper(bootStatus.helper)

async function requireAccessibility(): Promise<Response | null> {
  if (!bootStatus.helper) {
    return err(503, "meta-input-helper недоступен", bootStatus.hint)
  }
  if (bootStatus.accessibility) return null
  return err(503, "Accessibility не выдан meta-input-helper", bootStatus.hint)
}

async function refreshAccessibility(): Promise<void> {
  if (!bootStatus.helper) return
  const accessibility = await probeAccessibilityNow(bootStatus.helper)
  bootStatus = {
    ...bootStatus,
    accessibility,
    hint: accessibility
      ? undefined
      : `Разрешите Accessibility для ${bootStatus.helper}: System Settings → Privacy & Security → Accessibility`,
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const t0 = performance.now()
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    const res = await (async () => {
      try {
        if (path === "/health") {
          await refreshAccessibility()
          return json({
            ok: bootStatus.accessibility,
            backend: bootStatus.backend,
            helper: bootStatus.helper,
            accessibility: bootStatus.accessibility,
            hint: bootStatus.hint,
          })
        }

        if (path === "/bootstrap" && method === "POST") {
          bootStatus = await bootstrap(AUTO_REQUEST_ACCESSIBILITY)
          setNativeHelper(bootStatus.helper)
          setKeyboardNativeHelper(bootStatus.helper)
          return json({ ok: bootStatus.accessibility, ...bootStatus })
        }

        if (path === "/permissions/accessibility" && method === "GET") {
          if (!bootStatus.helper) {
            return json({ granted: false, helper: null, hint: bootStatus.hint })
          }
          const granted = await probeAccessibilityNow(bootStatus.helper)
          bootStatus = { ...bootStatus, accessibility: granted, hint: granted ? undefined : bootStatus.hint }
          return json({ granted, helper: bootStatus.helper })
        }

        if (path === "/permissions/accessibility" && method === "POST") {
          if (!bootStatus.helper) {
            bootStatus = await bootstrap(false)
            setNativeHelper(bootStatus.helper)
            setKeyboardNativeHelper(bootStatus.helper)
          }
          const requested = bootStatus.helper
            ? await requestAccessibilityNow(bootStatus.helper)
            : { accessibility: false, postEvents: false }
          const proc = Bun.spawn(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])
          await proc.exited
          const granted = bootStatus.helper
            ? await probeAccessibilityNow(bootStatus.helper)
            : false
          bootStatus = { ...bootStatus, accessibility: granted }
          return json({
            granted,
            requested: true,
            opened: true,
            helper: bootStatus.helper,
            preflight: requested,
            hint: granted
              ? undefined
              : `Включите в открывшемся списке: ${bootStatus.helper ?? "meta-input-helper"}, затем GET /permissions/accessibility`,
          })
        }

        // ─── Mouse ───────────────────────────────────────────────────────
        if (path === "/mouse/position" && method === "GET") {
          const denied = await requireAccessibility()
          if (denied) return denied
          return json(await getPosition())
        }

        if (path === "/mouse/move" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { x?: number; y?: number }
          if (body.x == null || body.y == null) return err(400, "need {x, y}", "Координаты в логических пикселях, (0,0) — левый верхний угол главного экрана")
          const r = await move(body.x, body.y)
          return json({ ok: true, ...r })
        }

        if (path === "/mouse/click" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json().catch(() => ({}))) as { x?: number; y?: number; button?: "left" | "right" | "middle"; count?: number }
          const r = await click(body)
          return json({ ok: true, ...r })
        }

        if (path === "/mouse/drag" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { from?: { x: number; y: number }; to?: { x: number; y: number }; durationMs?: number }
          if (!body.from || !body.to) return err(400, "need {from:{x,y}, to:{x,y}}", "Пример: {\"from\":{\"x\":100,\"y\":100},\"to\":{\"x\":300,\"y\":300}}")
          const r = await drag({ from: body.from, to: body.to, durationMs: body.durationMs })
          return json({ ok: true, ...r })
        }

        if (path === "/mouse/scroll" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { dx?: number; dy?: number }
          const r = await scroll(body)
          return json({ ok: true, ...r })
        }

        // ─── Keyboard ────────────────────────────────────────────────────
        if (path === "/keyboard/type" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { text?: string; delayMs?: number }
          if (body.text == null) return err(400, "missing 'text'", "Пример: {\"text\":\"Hello\",\"delayMs\":50}")
          await typeText(body.text, body.delayMs ?? 0)
          return json({ ok: true, length: body.text.length })
        }

        if (path === "/keyboard/key" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { key?: string; modifiers?: string[] }
          if (!body.key) return err(400, "missing 'key'", "Примеры: {\"key\":\"enter\"}, {\"key\":\"a\",\"modifiers\":[\"cmd\",\"shift\"]}")
          await pressKey(body.key, body.modifiers ?? [])
          return json({ ok: true })
        }

        if (path === "/keyboard/shortcut" && method === "POST") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const body = (await req.json()) as { shortcut?: string; delayMs?: number; sequence?: string[] }
          if (body.sequence) {
            await pressShortcuts(body.sequence, body.delayMs ?? 50)
            return json({ ok: true, count: body.sequence.length })
          }
          if (!body.shortcut) return err(400, "need {shortcut} or {sequence}", "Примеры: {\"shortcut\":\"cmd+shift+t\"}, {\"sequence\":[\"cmd+a\",\"cmd+c\"]}")
          await pressShortcut(body.shortcut)
          return json({ ok: true })
        }

        // ─── Convenience: координаты в query string для GET ───────────────
        if (path === "/mouse/move" && method === "GET") {
          const denied = await requireAccessibility()
          if (denied) return denied
          const x = num(url.searchParams.get("x"))
          const y = num(url.searchParams.get("y"))
          if (x == null || y == null) return err(400, "need x and y query params")
          const r = await move(x, y)
          return json({ ok: true, ...r })
        }

        return err(404, `${method} ${path} not found`,
          "Маршруты: GET /health /mouse/position; POST /mouse/{move,click,drag,scroll} /keyboard/{type,key,shortcut} /bootstrap")
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (e instanceof NativeInputError && e.code === 77) {
          await refreshAccessibility()
          return err(503, msg, bootStatus.hint)
        }
        let hint: string | undefined
        if (msg.includes("Accessibility")) {
          hint = bootStatus.hint ?? "Нет разрешения Accessibility для meta-input-helper"
        }
        return err(500, msg, hint)
      }
    })()
    logRequest(method, path, res.status, Math.round(performance.now() - t0))
    return res
  },
})

printBanner("@meta/input", PORT, [
  { routes: [
    { method: "GET",  path: "/health",    description: "состояние и доступные инструменты" },
    { method: "POST", path: "/bootstrap", description: "собрать helper + проверить Accessibility" },
  ]},
  { title: "Мышь", routes: [
    { method: "GET",  path: "/mouse/position", description: "текущие координаты" },
    { method: "POST", path: "/mouse/move",     description: "переместить курсор  ({x,y})" },
    { method: "POST", path: "/mouse/click",    description: "клик  ({x?,y?,button?,count?})" },
    { method: "POST", path: "/mouse/drag",     description: "drag  ({from,to,durationMs?})" },
    { method: "POST", path: "/mouse/scroll",   description: "прокрутка  ({dx?,dy?})" },
  ]},
  { title: "Клавиатура", routes: [
    { method: "POST", path: "/keyboard/type",     description: "набрать текст  ({text,delayMs?})" },
    { method: "POST", path: "/keyboard/key",      description: "нажать клавишу  ({key,modifiers?})" },
    { method: "POST", path: "/keyboard/shortcut", description: "сочетание  ({shortcut} или {sequence})" },
  ]},
  { title: "Разрешения", routes: [
    { method: "GET",  path: "/permissions/accessibility", description: "проверить Accessibility" },
    { method: "POST", path: "/permissions/accessibility", description: "открыть System Settings" },
  ]},
])
console.log(`  backend: ${bootStatus.backend}   helper: ${bootStatus.helper ?? "—"}`)
