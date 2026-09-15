import type { ContractError, ContractErrorCode, RecoveryAction } from "@meta/shared/contracts"

export class RuntimeContractError extends Error {
  readonly contract: ContractError

  constructor(
    code: ContractErrorCode,
    message: string,
    stage: string,
    options: {
      retryable?: boolean
      replayAllowed?: boolean
      recoveryAction?: RecoveryAction
      context?: ContractError["context"]
    } = {},
  ) {
    super(message)
    this.name = "RuntimeContractError"
    this.contract = {
      code,
      message,
      stage,
      retryable: options.retryable ?? false,
      replayAllowed: options.replayAllowed ?? false,
      recoveryAction: options.recoveryAction ?? "none",
      ...(options.context === undefined ? {} : { context: options.context }),
    }
  }
}

export function contractErrorFrom(error: unknown, stage: string): ContractError {
  if (error instanceof RuntimeContractError) return error.contract
  return {
    code: "internal-error",
    message: error instanceof Error ? error.message : "Неизвестная runtime ошибка",
    stage,
    retryable: false,
    replayAllowed: false,
    recoveryAction: "get-operation",
  }
}
