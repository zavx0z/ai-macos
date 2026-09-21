import type {DispatcherInput} from "../../dispatch/contract/input.ts"

/** Trusted HTTP-host dependencies; these fields never come from a remote tool call. */
export interface RequestInput extends DispatcherInput {
  token: string
  logger?: (event: {requestId: string; method: string; node?: string; action?: string; status: number; durationMs: number; errorCode?: string}) => void
}
