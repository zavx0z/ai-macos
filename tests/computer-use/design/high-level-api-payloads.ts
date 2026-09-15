import { resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../../..")
const runtimeDirectory = resolve(repositoryRoot, "runtime")
const contractsEntry = Bun.resolveSync("@meta/shared/contracts", runtimeDirectory)
const contracts = await import(contractsEntry)
const inputMethods = await import(resolve(repositoryRoot, "runtime/src/input-methods.ts"))

const generation = {
  runtimeEpoch: "runtime-fixture",
  loginSessionId: "login-fixture"
}
const nativeGeneration = "native-fixture"
const windowRef = {
  ...generation,
  nativeGeneration,
  applicationRef: "application-chrome",
  windowRef: "window-chrome-hidden"
}
const fixtureWindowRef = {
  ...generation,
  nativeGeneration,
  applicationRef: "application-ui-fixture",
  windowRef: "window-fixture-primary"
}
const browserInstance = {
  ...generation,
  browserInstanceRef: "browser-work-profile",
  transportGeneration: "chrome-transport-7"
}
const connectedBrowserInstance = {
  ...browserInstance,
  transportGeneration: "chrome-transport-8"
}
const browserTarget = {
  ...connectedBrowserInstance,
  targetId: "target-identical-url-b",
  resourceRef: "target-resource-b"
}

type ModelCall = {
  method: string
  arguments: Record<string, unknown>
}

type ScenarioCalls = {
  current: ModelCall[]
  proposed: ModelCall[]
  currentTraceStatus:
    | "expressible-current-api"
    | "blocked-before-action"
    | "blocked-pending-operation-id"
  proposedLostReplyRecovery?: ModelCall[]
}

function currentIntent(
  clientRequestId: string,
  target: Record<string, unknown>,
  inventoryId: string,
  inventoryRevision: number,
  resources: unknown[]
) {
  const value = {
    intent: "mutation",
    clientRequestId,
    precondition: { target, inventoryId, inventoryRevision },
    deadlineAt: "2026-09-15T13:00:00.000Z",
    requestedResources: resources
  }
  contracts.runtimeOperationIntentSchema.parse(value)
  return value
}

const connectRequest = {
  kind: "connect-instance",
  instance: browserInstance
} as const
contracts.browserOperationRequestSchema.parse(connectRequest)
const readAccessibilityRequest = {
  kind: "read-accessibility",
  target: browserTarget,
  maxNodes: 200,
  maxBytes: 65536
} as const
contracts.browserOperationRequestSchema.parse(readAccessibilityRequest)

const scenarios: Record<string, ScenarioCalls> = {
  hiddenChrome: {
    currentTraceStatus: "expressible-current-api",
    current: [
      { method: "list_windows", arguments: { app: "Google Chrome" } },
      {
        method: "window_transition",
        arguments: {
          inventoryId: "inventory-desktop-41",
          inventoryRevision: 41,
          clientRequestId: "request-show-hidden-chrome",
          request: {
            kind: "show",
            target: windowRef
          }
        }
      }
    ],
    proposed: [
      {
        method: "get_state",
        arguments: {
          kind: "window",
          app: "Google Chrome"
        }
      },
      {
        method: "show_window",
        arguments: { targetId: "window_hidden_chrome_7" }
      }
    ]
  },
  identicalUrlProfiles: {
    currentTraceStatus: "expressible-current-api",
    current: [
      { method: "browser_chrome_instances", arguments: {} },
      {
        method: "browser_chrome_operation",
        arguments: {
          intent: currentIntent(
            "request-connect-work-profile",
            { kind: "browser-instance", ref: browserInstance },
            "inventory-browser-7",
            7,
            contracts.browserOperationResources(connectRequest)
          ),
          request: connectRequest
        }
      },
      {
        method: "browser_chrome_targets",
        arguments: { instance: connectedBrowserInstance }
      },
      {
        method: "browser_chrome_operation",
        arguments: {
          intent: currentIntent(
            "request-activate-target-b",
            { kind: "browser-target", ref: browserTarget },
            "inventory-browser-targets-9",
            9,
            contracts.browserOperationResources(readAccessibilityRequest)
          ),
          request: readAccessibilityRequest
        }
      }
    ],
    proposed: [
      {
        method: "get_state",
        arguments: { kind: "browser" }
      },
      {
        method: "get_tabs",
        arguments: { browserId: "browser_work_profile" }
      },
      {
        method: "observe",
        arguments: {
          targetId: "tab_identical_url_b",
          mode: "ax"
        }
      }
    ]
  },
  accessibilityElementAction: {
    currentTraceStatus: "blocked-before-action",
    current: [
      { method: "list_windows", arguments: { app: "Computer Use Fixture" } },
      {
        method: "inspect_accessibility",
        arguments: {
          inventoryId: "inventory-desktop-42",
          inventoryRevision: 42,
          request: {
            target: { kind: "window", ref: fixtureWindowRef },
            depth: 6,
            maxNodes: 200,
            maxBytes: 65536
          }
        }
      }
    ],
    proposed: [
      {
        method: "get_state",
        arguments: {
          kind: "window",
          app: "Computer Use Fixture"
        }
      },
      {
        method: "observe",
        arguments: {
          targetId: "window_fixture_primary",
          mode: "ax"
        }
      },
      {
        method: "click",
        arguments: {
          targetId: "window_fixture_primary",
          elementId: "element_save_42"
        }
      }
    ]
  },
  cancelInput: {
    currentTraceStatus: "blocked-pending-operation-id",
    current: [
      { method: "list_windows", arguments: { app: "Computer Use Fixture" } },
      {
        method: "keyboard_type",
        arguments: {
          clientRequestId: "request-type-cancellable",
          precondition: {
            target: { kind: "window", ref: fixtureWindowRef },
            inventoryId: "inventory-desktop-43",
            inventoryRevision: 43
          },
          action: {
            kind: "text",
            text: "English Русский 👩🏽‍💻"
          }
        }
      },
      {
        method: "cancel_operation",
        arguments: {
          operationId: "operation-type-17",
          reason: "user-requested"
        }
      }
    ],
    proposed: [
      {
        method: "get_state",
        arguments: {
          kind: "window",
          app: "Computer Use Fixture"
        }
      },
      {
        method: "type_text",
        arguments: {
          targetId: "window_fixture_primary",
          text: "English Русский 👩🏽‍💻"
        }
      },
      {
        method: "cancel_target",
        arguments: {
          targetId: "window_fixture_primary",
          reason: "user-requested"
        }
      }
    ],
    proposedLostReplyRecovery: [
      {
        method: "get_target_status",
        arguments: { targetId: "window_fixture_primary" }
      }
    ]
  }
}

const forbiddenFacadeKeys = new Set([
  "runtimeEpoch",
  "loginSessionId",
  "nativeGeneration",
  "inventoryId",
  "inventoryRevision",
  "fence",
  "proofRef",
  "observationRef",
  "evidence"
])

contracts.windowTransitionRequestSchema.parse(
  scenarios.hiddenChrome.current[1]?.arguments.request
)
contracts.axInspectionRequestSchema.parse(
  scenarios.accessibilityElementAction.current[1]?.arguments.request
)
inputMethods.keyboardTypeMethodInputSchema.parse(
  scenarios.cancelInput.current[1]?.arguments
)

function assertProposedPayload(value: unknown): void {
  JSON.stringify(value)
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenFacadeKeys.has(key)) {
        throw new Error(`Proposed fixture exposes internal field ${key}`)
      }
      visit(child)
    }
  }
  visit(value)
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function highLevelPayloadReport() {
  return Object.fromEntries(Object.entries(scenarios).map(([name, scenario]) => {
    for (const call of scenario.proposed) assertProposedPayload(call)
    const measure = (calls: ModelCall[]) => ({
      modelVisibleCalls: calls.length,
      requestJsonBytes: calls.map((call) => bytes(call)),
      totalRequestJsonBytes: calls.reduce((total, call) => total + bytes(call), 0)
    })
    return [name, {
      current: {
        ...measure(scenario.current),
        traceStatus: scenario.currentTraceStatus
      },
      proposed: {
        ...measure(scenario.proposed),
        traceStatus: "design-fixture-only"
      },
      ...(scenario.proposedLostReplyRecovery === undefined
        ? {}
        : {
            proposedLostReplyRecovery: measure(
              scenario.proposedLostReplyRecovery
            )
          })
    }]
  }))
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(highLevelPayloadReport(), null, 2)}\n`)
}
