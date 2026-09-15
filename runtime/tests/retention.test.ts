import { expect, test } from "bun:test"
import { FrameStore, ProofRegistry } from "../src/authorities.ts"
import { sha256 } from "../src/primitives.ts"

const generation = { runtimeEpoch: "runtime:retention", loginSessionId: "login:retention" }
const target = { kind: "browser-target" as const, ref: { ...generation,
  browserInstanceRef: "browser:retention", transportGeneration: "transport:retention", targetId: "target:retention", resourceRef: "resource:retention" } }

test("frame retention ограничена global bytes/frames across lineages и очищает expired bytes", async () => {
  let now = Date.now()
  const frames = new FrameStore(generation, { clock: { now: () => new Date(now) }, maxFrames: 2, maxFramesPerScope: 2, maxBytes: 5 })
  const add = async (id: string, scope: string, size: number) => {
    const publication = frames.registerPublication({ ...generation, observationId: `observation:${id}`, frameRef: `frame:${id}`,
      source: "browser-viewport", captureTarget: target, capturePolicySha256: "a".repeat(64), expiresAt: new Date(now + 1000).toISOString(),
      inventoryId: "inventory:retention", inventoryRevision: 1, displayLayoutRevision: 1, cacheScopeRef: scope })
    const bytes = new Uint8Array(size).fill(1)
    const request = { ...generation, observationId: publication.observationId, frameRef: publication.frameRef,
      source: "browser-viewport" as const, target, capturedAt: new Date(now).toISOString(), widthPx: 1, heightPx: 1,
      mime: "image/png" as const, expectedByteLength: size, expectedSha256: sha256(bytes), bytes }
    await frames.publish(request)
    return { publication, request }
  }
  const first = await add("first", "lineage:first", 3)
  await add("second", "lineage:second", 3)
  expect(frames.get(first.publication.frameRef, "lineage:first")).toBeUndefined()
  expect(frames.stats()).toMatchObject({ frames: 1, bytes: 3 })
  await expect(frames.publish(first.request)).rejects.toThrow("перезаписан")
  await add("third", "lineage:third", 1)
  await add("fourth", "lineage:fourth", 1)
  expect(frames.stats()).toMatchObject({ frames: 2, bytes: 2 })
  now += 1001
  expect(frames.stats()).toMatchObject({ frames: 0, bytes: 0, publications: 0, issuedRefs: 4 })
  expect(() => frames.registerPublication(first.publication)).toThrow("уже существует")
})

test("browser proof в mixed native host не получает native generation", () => {
  const proofs = new ProofRegistry(generation, { nativeGeneration: "native:retention" })
  const proof = proofs.issue({ kind: "frame-freshness", subject: target, inventoryRevision: 1, displayLayoutRevision: 1, ttlMs: 1000 })
  expect(proof.nativeGeneration).toBeUndefined()
  expect(proofs.hasIssued(proof)).toBe(true)
})
