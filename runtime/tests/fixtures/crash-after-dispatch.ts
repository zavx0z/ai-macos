import { RuntimeCore } from "../../src/core.ts"
import { FileOperationJournal } from "../../src/storage/index.ts"
import { runtimeOperationIntentSchema } from "@meta/shared/contracts"

const directory = process.argv[2]!
const generation = { runtimeEpoch: "runtime:crash", loginSessionId: "login:crash" }
const core = new RuntimeCore({ generation, runtimeBuildId: "build:crash", operationJournal: new FileOperationJournal(directory) })
await core.initializeRecovery()
const session = core.openClient("principal:crash").session
const target = { kind: "clipboard" as const, ref: { ...generation, clipboardRef: "system" as const } }
core.targets.register(target, "inventory:crash", 0, "resolution:crash", "proof:crash", 0)
await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:crash",
  precondition: { target, inventoryId: "inventory:crash", inventoryRevision: 0 }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
  requestedResources: [{ kind: "clipboard", resourceRef: "system" }],
}), { privateText: "never journalled" }, async context => {
  process.stdout.write(`${context.wire.operationId}\n`)
  process.exit(0)
})
