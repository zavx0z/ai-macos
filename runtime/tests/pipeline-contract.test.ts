import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { CAPABILITY_IDS } from "@meta/shared/contracts"
import { createRuntimeHost } from "../src/host.ts"

test("Runtime exposes one bounded pipeline without arbitrary method/script execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cu-pipeline-contract-"))
  const host = await createRuntimeHost({ socketPath: join(directory, "r.sock"),
    credentialPath: join(directory, "client.json"), stateDirectory: join(directory, "state"),
    runtimeBuildId: "build:pipeline-test", expectedNativeBuildId: "native:unused",
    expectedHostname: hostname(), loginSessionId: "login:pipeline-test" })
  try {
    host.core.updateCapabilities({ schemaVersion: "1", scope: "runtime", producerRef: "test:pipeline",
      capabilities: CAPABILITY_IDS.map(id => ({ id, state: "ready" })) })
    const descriptor = host.catalog.descriptors().tools.find(tool => tool.name === "run_pipeline")
    expect(descriptor).toBeDefined()
    expect(descriptor?._meta?.timeoutMs).toBe(30_000)
    const schema = JSON.stringify(descriptor?.inputSchema)
    expect(schema).toContain("anchors")
    expect(schema).toContain("sequence")
    expect(schema).toContain("maxChunks")
    expect(schema).toContain("offsetBytes")
    expect(schema).toContain("expectedSnapshotSha256")
    expect(schema).toContain("resourceUrl")
    const output = JSON.stringify(descriptor?.outputSchema)
    for (const field of ["content", "snapshotSha256", "nextOffsetBytes", "totalBytes", "chunks", "resource"]) {
      expect(output).toContain(field)
    }
    expect(schema).not.toContain("evaluate")
    expect(schema).not.toContain("shell")
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})
