type DiagnosticFields = Record<string, unknown>

export type ProcessDiagnostics = {
  log: (event: string, fields?: DiagnosticFields) => void
}

export function installProcessDiagnostics(component: string): ProcessDiagnostics {
  const log = (event: string, fields: DiagnosticFields = {}): void => {
    const record = {
      time: new Date().toISOString(),
      component,
      event,
      pid: process.pid,
      ppid: process.ppid,
      ...fields,
    }
    process.stderr.write(`${JSON.stringify(record)}\n`)
  }

  process.stdin.once("end", () => log("stdin_end"))
  process.stdin.once("close", () => log("stdin_close"))
  process.stdin.once("error", (error) => log("stdin_error", serializeError(error)))
  process.once("beforeExit", (code) => log("process_before_exit", {code}))
  process.once("exit", (code) => log("process_exit", {code}))
  process.once("uncaughtException", (error) => {
    log("uncaught_exception", serializeError(error))
    process.exit(1)
  })
  process.once("unhandledRejection", (reason) => {
    log("unhandled_rejection", serializeError(reason))
    process.exit(1)
  })

  log("process_started")
  return {log}
}

function serializeError(error: unknown): DiagnosticFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    }
  }
  return {errorMessage: String(error)}
}
