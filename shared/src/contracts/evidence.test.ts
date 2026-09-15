import { expect, test } from "bun:test"
import {
  evidenceReportMatchesReceipt,
  nativeEvidenceReportSchema,
  observationPublicationSchema,
  verifiedNativeEvidenceReceiptSchema,
} from "./index.ts"
import {
  displayRef,
  loginSessionId,
  nativeGeneration,
  now,
  proof,
  runtimeEpoch,
  windowRef,
} from "./test-fixtures.ts"

const windowTarget = { kind: "window", ref: windowRef } as const

test("native evidence report содержит discriminated facts, но не self-asserted digest/build", () => {
  const report = nativeEvidenceReportSchema.parse({
    factKind: "window-cg-ax-correlation",
    sourceResponseRef: "native-response:1",
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    observedAt: now,
    target: windowTarget,
    mapping: {
      kind: "window",
      cgWindowId: 55,
      ownerPid: 42,
      displays: [{ nativeDisplayId: 1, ref: displayRef }],
    },
    corroboration: {
      axSnapshotRef: "ax-snapshot:1",
      cgInventoryRef: "cg-inventory:1",
    },
  })
  expect(nativeEvidenceReportSchema.safeParse({
    ...report,
    sourceResponseSha256: "a".repeat(64),
    backendBuildId: "caller-build",
    confirmed: true,
  }).success).toBe(false)
  const receipt = verifiedNativeEvidenceReceiptSchema.parse({
    evidenceReceiptId: "evidence:1",
    adapterInstanceRef: "native-adapter:1",
    backendBuildId: "native-build:1",
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    sourceResponseRef: report.sourceResponseRef,
    sourceResponseSha256: "b".repeat(64),
    inventoryId: report.inventoryId,
    inventoryRevision: report.inventoryRevision,
    displayLayoutRevision: report.displayLayoutRevision,
    observedAt: report.observedAt,
    factKind: report.factKind,
    factSha256: "c".repeat(64),
    issuedAt: now,
  })
  expect(evidenceReportMatchesReceipt(report, receipt)).toBe(true)
  expect(evidenceReportMatchesReceipt(report, { ...receipt, inventoryRevision: 5 })).toBe(false)
})

test("runtime preissues observationId и frameRef вместе", () => {
  expect(observationPublicationSchema.parse({
    observationId: "observation:1",
    frameRef: "frame:1",
    source: "display-composite",
    captureTarget: { kind: "display", ref: displayRef },
    capturePolicySha256: "a".repeat(64),
    runtimeEpoch,
    loginSessionId,
    nativeGeneration,
    expiresAt: "2026-09-15T10:01:00.000Z",
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    cacheScopeRef: "client:1",
  }).frameRef).toBe("frame:1")
  expect(observationPublicationSchema.safeParse({
    observationId: "observation:1",
    source: "display-composite",
    captureTarget: { kind: "display", ref: displayRef },
    capturePolicySha256: "a".repeat(64),
    runtimeEpoch,
    loginSessionId,
    expiresAt: "2026-09-15T10:01:00.000Z",
    inventoryId: "inventory:1",
    inventoryRevision: 4,
    displayLayoutRevision: 3,
    cacheScopeRef: "client:1",
  }).success).toBe(false)
})
