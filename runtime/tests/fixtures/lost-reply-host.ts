import { z } from "@meta/shared/contracts"
import { createProcessFixtureHost } from "./process-host.ts"

const host = await createProcessFixtureHost(process.argv[2]!)
host.catalog.register("fixture_lost_reply", {
  title: "Потерянный ответ", description: "Fake action для проверки durable discovery", readOnly: false,
  input: z.strictObject({ text: z.string() }), output: z.strictObject({}), timeoutMs: 5000,
  async execute(context, request) {
    const target = { kind: "clipboard" as const, ref: { ...host.core.generation, clipboardRef: "system" as const } }
    host.core.targets.register(target, "inventory:lost-reply", 1, "resolution:lost-reply", "proof:lost-reply", 0)
    await host.core.runOperation(context.session, { intent: "mutation", clientRequestId: `private-request:${crypto.randomUUID()}`,
      precondition: { target, inventoryId: "inventory:lost-reply", inventoryRevision: 1 },
      requestedResources: [{ kind: "clipboard", resourceRef: "system" }], deadlineAt: new Date(Date.now() + 5000).toISOString(),
    }, request, async () => {
      process.stdout.write("entered\n")
      return new Promise(() => {})
    }, context.signal)
    return {}
  },
})
await host.start()
process.stdout.write("ready\n")
