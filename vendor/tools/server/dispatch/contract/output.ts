import type {ToolRequest} from "./input.ts"

/** No listener, session, process launcher, retries or MCP registration. */
export interface DispatcherOutput {
  /** Returns the public function's result; errors propagate to the calling host. */
  dispatch(request?: ToolRequest): Promise<unknown>
}
