import { expect, test } from "bun:test"
import { applicationLaunchRequestSchema, applicationBundleResolutionSchema, applicationQuitRequestSchema } from "./applications.ts"
import { operationTargetSchema } from "./identities.ts"

const bundle = { runtimeEpoch: "runtime:app", loginSessionId: "login:app", nativeGeneration: "native:app",
  bundleRef: "bundle:app", bundleId: "dev.meta.fixture", path: "/Applications/Fixture.app",
  device: "1", inode: "123456", modifiedAtNs: "1700000000000000000" }

test("launch использует установленный bundle до появления process ref", () => {
  expect(operationTargetSchema.parse({ kind: "application-bundle", ref: bundle }).kind).toBe("application-bundle")
  expect(applicationLaunchRequestSchema.parse({ bundle })).toMatchObject({ activate: true, newInstance: false })
  expect(applicationQuitRequestSchema.safeParse({ application: bundle }).success).toBe(false)
  expect(applicationLaunchRequestSchema.safeParse({ bundle: { ...bundle, inode: 123456 } }).success).toBe(false)
})

test("bundle resolution сохраняет native snapshot и точную файловую identity", () => {
  const result = applicationBundleResolutionSchema.parse({ requestedPath: bundle.path, sourceResponseRef: "source:app", inventoryId: "inventory:app",
    inventoryRevision: 1, observedAt: new Date().toISOString(), target: { kind: "application-bundle", ref: bundle } })
  expect(result.target.ref.modifiedAtNs).toBe(bundle.modifiedAtNs)
  expect(applicationLaunchRequestSchema.safeParse({ bundle: { ...bundle, path: "Fixture.app" } }).success).toBe(false)
})
