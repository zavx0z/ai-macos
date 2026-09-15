export const LIVE_CLIPBOARD_ENV = "AI_MACOS_LIVE_CLIPBOARD"

export function liveClipboardEnabled(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): boolean {
  return environment[LIVE_CLIPBOARD_ENV] === "true"
}
