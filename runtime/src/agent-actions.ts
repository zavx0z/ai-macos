import { chatBrowserActions } from "./agent-browser-policy.ts"

export const computerActions = [
  "system_health", "get_state", "observe", "show_window", "check_input", "click",
  "type_text", "press_key", "press_shortcut", "scroll", "get_target_status",
  "cancel_target", "get_operation", "list_recent_operations", "recover_startup_input", "run_pipeline",
  ...chatBrowserActions,
] as const
export const defaultAgentActions: ReadonlySet<string> = new Set(computerActions)
