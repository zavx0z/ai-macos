import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeHandshakeResponseSchema } from "@meta/shared/contracts"
import { NativeActorJournal } from "../src/native-actor.ts"
import { syncFileAndParent } from "../src/storage/atomic-file.ts"

test("actor quiescence требует owned exit или отсутствие exact old PID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-actor-"))
  let absent = false
  const store = new NativeActorJournal(directory, "login:actor", { absent: () => absent })
  const handshake = nativeHandshakeResponseSchema.parse({ kind: "handshake-response", protocolVersion: "1", requestId: "handshake:actor",
    runtimeEpoch: "runtime:actor", loginSessionId: "login:actor", nativeGeneration: "native:actor", nativeBuildId: "build:actor",
    capabilitySchemaVersion: "1", installRoot: "/tmp/actor-fixture",
    process: { pid: 100, startedAt: new Date().toISOString(), nonce: "nonce:actor" },
    session: { verified: true, source: "darwin-audit", uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 100 },
    capabilities: { schemaVersion: "1", scope: "adapter", producerRef: "native:actor", capabilities: [] } })
  try {
    const actor = await store.register(handshake, "/tmp/actor-fixture/helper")
    expect((await store.quiescence(actor.runtimeEpoch, actor.nativeGeneration)).state).toBe("unknown")
    absent = true
    expect(await store.quiescence(actor.runtimeEpoch, actor.nativeGeneration)).toMatchObject({ state: "exited", source: "process-absent" })
    absent = false
    await store.markConfirmedExit(actor)
    expect(await store.quiescence(actor.runtimeEpoch, actor.nativeGeneration)).toMatchObject({ state: "exited", source: "owned-exit" })
    expect((await store.quiescence("runtime:missing", "native:missing")).state).toBe("unknown")
    await expect(store.register({ ...handshake, process: { ...handshake.process, nonce: "nonce:other" } }, "/tmp/actor-fixture/helper")).rejects.toThrow("immutable conflict")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const phase of ["register", "exit"] as const) {
  test(`actor ${phase} retry после rename повторяет fsync и сохраняет identity`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-actor-sync-"))
    let fail = phase === "register"
    let synced = 0
    const store = new NativeActorJournal(directory, "login:actor-sync", {
      failpoint(stage) { if (fail && stage === "after-rename") throw new Error("injected parent sync failure") },
      async sync(path) { synced++; await syncFileAndParent(path) },
    })
    const handshake = nativeHandshakeResponseSchema.parse({ kind: "handshake-response", protocolVersion: "1", requestId: "hs:sync",
      runtimeEpoch: "runtime:actor-sync", loginSessionId: "login:actor-sync", nativeGeneration: "native:actor-sync", nativeBuildId: "build:actor-sync",
      capabilitySchemaVersion: "1", installRoot: "/tmp/actor-sync", process: { pid: 101, startedAt: new Date().toISOString(), nonce: "nonce:sync" },
      session: { verified: true, source: "darwin-audit", uid: process.getuid!(), effectiveUid: process.geteuid!(), auditUserId: process.getuid!(), auditSessionId: 1 },
      capabilities: { scope: "adapter", schemaVersion: "1", producerRef: "actor-sync", capabilities: [] } })
    try {
      if (phase === "register") await expect(store.register(handshake, "/tmp/actor-sync/helper")).rejects.toThrow("sync failure")
      else await store.register(handshake, "/tmp/actor-sync/helper")
      let before = (await store.read(handshake.runtimeEpoch, handshake.nativeGeneration))!
      if (phase === "exit") {
        fail = true
        await expect(store.markConfirmedExit(before)).rejects.toThrow("sync failure")
        before = (await store.read(handshake.runtimeEpoch, handshake.nativeGeneration))!
      }
      fail = false
      if (phase === "register") await store.register(handshake, "/tmp/actor-sync/helper")
      else await store.markConfirmedExit(before)
      expect(synced).toBe(1)
      expect(await store.read(handshake.runtimeEpoch, handshake.nativeGeneration)).toEqual(before)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
