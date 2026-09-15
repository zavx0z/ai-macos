import { RuntimeCore } from "../../src/core.ts"
import { FileOperationJournal } from "../../src/storage/index.ts"
import { runtimeOperationIntentSchema, type NativeAdapter } from "@meta/shared/contracts"

const directory = process.argv[2]!
const phase = process.argv[3]!
const generation = { runtimeEpoch: "runtime:domain-crash", loginSessionId: "login:domain-crash" }
const nativeGeneration = "native:domain-crash"
const core = new RuntimeCore({ generation, runtimeBuildId: "build:domain-crash", nativeGeneration, native: {} as NativeAdapter,
  operationJournal: new FileOperationJournal(directory), nativeRecovery: { policyVersion: "1", nativeBuildId: "native-build:domain-crash" } })
await core.initializeRecovery()
const session = core.openClient("principal:domain-crash").session
const target = { kind: "display" as const, ref: { ...generation, nativeGeneration, displayRef: "display:domain", displayLayoutRevision: 0 } }
core.targets.register(target, "inventory:domain", 0, "resolution:domain", "proof:domain", 0)
await core.runOperation(session, runtimeOperationIntentSchema.parse({ intent: "mutation", clientRequestId: "request:domain-crash",
  precondition: { target, inventoryId: "inventory:domain", inventoryRevision: 0 }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
  requestedResources: [{ kind: "desktop-input", resourceRef: "desktop" }],
}), { privateText: "не должен сохраняться" }, async context => {
  if (context.wire.kind !== "native") throw new Error("Native context expected")
  if (phase === "authorized") await core.authorizeNativeMutation(context.wire, { policyVersion: "1",
    nativeBuildId: "native-build:domain-crash", method: "input.execute", domain: "no-held-input", possibleHolds: [] })
  process.stdout.write(context.wire.operationId)
  process.exit(0)
})
