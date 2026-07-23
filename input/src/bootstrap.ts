import {
  ensureNativeHelper,
  probeNativeAccessibility,
  requestNativeAccessibility,
} from "./native.ts"

const G = "\x1b[32m"
const Y = "\x1b[33m"
const D = "\x1b[2m"
const C = "\x1b[36m"
const RESET = "\x1b[0m"

const OK = `${G}✓${RESET}`
const WARN = `${Y}!${RESET}`

export type InputBootstrapStatus = {
  backend: "native-helper"
  helper: string | null
  accessibility: boolean
  hint?: string
}

export async function probeAccessibilityNow(helper: string): Promise<boolean> {
  return await probeNativeAccessibility(helper)
}

export async function requestAccessibilityNow(
  helper: string,
): Promise<{ accessibility: boolean; postEvents: boolean }> {
  return await requestNativeAccessibility(helper)
}

export async function bootstrap(autoRequest = true): Promise<InputBootstrapStatus> {
  console.log()
  console.log(`  ${C}@meta/input bootstrap${RESET}`)

  let helper: string
  try {
    helper = await ensureNativeHelper()
    console.log(`  ${OK} native helper (${helper})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ${WARN} ${message}`)
    console.log()
    return {
      backend: "native-helper",
      helper: null,
      accessibility: false,
      hint: message,
    }
  }

  let accessibility = await probeAccessibilityNow(helper)
  if (!accessibility && autoRequest) {
    await requestAccessibilityNow(helper)
    accessibility = await probeAccessibilityNow(helper)
  }

  if (accessibility) {
    console.log(`  ${OK} Accessibility разрешён`)
    console.log()
    return { backend: "native-helper", helper, accessibility: true }
  }

  const hint =
    `Разрешите Accessibility для ${helper}: ` +
    "System Settings → Privacy & Security → Accessibility"
  console.log(`  ${WARN} Accessibility не выдан meta-input-helper`)
  console.log(`  ${D}↳ ${hint}${RESET}`)
  console.log()
  return {
    backend: "native-helper",
    helper,
    accessibility: false,
    hint,
  }
}
