import { hostname } from "node:os"
import { join } from "node:path"
import { z } from "@meta/shared/contracts"
import { createRuntimeHost } from "../../src/host.ts"

export async function createProcessFixtureHost(directory: string) {
  const host = await createRuntimeHost({ socketPath: join(directory, "runtime.sock"), credentialPath: join(directory, "credential.json"),
    expectedHostname: hostname(), loginSessionId: "login:process-host", runtimeBuildId: "build:process-host", expectedNativeBuildId: "native:unused" })
  host.catalog.register("lineage", { title: "Lineage", description: "Проверка process crash", readOnly: true,
    input: z.strictObject({}), output: z.strictObject({ lineage: z.string(), epoch: z.string() }),
    async execute(context) { return { lineage: host.core.clients.lineage(context.session), epoch: host.core.generation.runtimeEpoch } } })
  return host
}

if (import.meta.main) {
  const host = await createProcessFixtureHost(process.argv[2]!)
  await host.start()
  process.stdout.write("ready\n")
}
