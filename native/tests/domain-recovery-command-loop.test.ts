import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  heldInputLedgerDigest,
  nativeRecoveryGrantSchema,
  type HeldInputLedgerSnapshot,
  type NativeRecoveryDescriptor,
} from "@meta/shared/contracts"
import { NativeBrokerAdapter, NativeProcessTransport } from "../src/adapter.ts"
import {
  nativeDomainRecoveryRequestSchema,
  nativeDomainRecoveryResponseSchema,
  recoveryValueSha256,
  verifyDomainRecoveryAllUp,
  type NativeDomainRecoveryRequest,
} from "../src/domain-recovery-protocol.ts"

let directory = ""
let binary = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-domain-recovery-loop."))
  binary = join(directory, "fixture")
  const native = join(import.meta.dir, "..")
  const sources = [
    "command_loop.m",
    "broker_transport.m",
    "operation-receipts/meta_operation_receipts.m",
    "input_job.m",
    "domain-recovery/meta_domain_recovery.m",
    "recovery-probe/meta_recovery_probe.m",
    "recovery-domain/meta_recovery_domain.m",
    "ledger.c",
  ].map(path => join(native, "src", path))
  const compile = Bun.spawn([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-fblocks",
    "-mmacosx-version-min=13.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${join(native, "include")}`,
    `-I${join(native, "src")}`,
    ...sources,
    join(import.meta.dir, "domain-recovery-command-loop_fixture.m"),
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-o",
    binary,
  ], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
  const symbols = Bun.spawnSync(["/usr/bin/nm", "-u", binary])
  const undefinedSymbols = symbols.stdout.toString()
  for (const forbidden of ["CGEventPost", "meta_executor_", "meta_macos_input_"]) {
    if (undefinedSymbols.includes(forbidden)) {
      throw new Error(`Passive fixture неожиданно линкует mutation symbol ${forbidden}`)
    }
  }
}, 30_000)

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true })
})

const generation = {
  runtimeEpoch: "runtime-current",
  loginSessionId: "login-same",
  nativeGeneration: "native-current",
}

type Hold = NativeRecoveryDescriptor["possibleHolds"][number]
const historicalUnicodeContext = "секретный / путь\nввод"
const historicalUnicodeContextSha = recoveryValueSha256({
  method: "input.execute",
  action: { kind: "text", clusters: [{ text: historicalUnicodeContext }] },
})

function descriptor(holds: Hold[]): NativeRecoveryDescriptor {
  return {
    policyVersion: "1",
    nativeBuildId: "build-old",
    method: "input.execute",
    domain: "possible-held-input",
    possibleHolds: holds,
  }
}

function grant(holds: Hold[]) {
  const value = descriptor(holds)
  return nativeRecoveryGrantSchema.parse({
    policyVersion: "1",
    runtimeEpoch: "runtime-old",
    loginSessionId: generation.loginSessionId,
    nativeGeneration: "native-old",
    operationId: "operation-old",
    contextSha256: historicalUnicodeContextSha,
    descriptor: value,
    descriptorSha256: recoveryValueSha256(value),
    journalRevision: 3,
    durable: true,
  })
}

function ledger(entries: HeldInputLedgerSnapshot["entries"]): HeldInputLedgerSnapshot {
  return {
    canonicalVersion: "1",
    operationId: "operation-old",
    runtimeEpoch: "runtime-old",
    loginSessionId: generation.loginSessionId,
    nativeGeneration: "native-old",
    revision: 7,
    entries,
  }
}

function request(
  requestId: string,
  holds: Hold[],
  persisted?: HeldInputLedgerSnapshot,
): NativeDomainRecoveryRequest {
  const recoveryGrant = grant(holds)
  return nativeDomainRecoveryRequestSchema.parse({
    kind: "domain-recovery",
    protocolVersion: "1",
    requestId,
    ...generation,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    grant: recoveryGrant,
    ...(persisted === undefined ? {} : {
      ledger: persisted,
      ack: {
        requestId: `ledger-${requestId}`,
        operationId: persisted.operationId,
        runtimeEpoch: persisted.runtimeEpoch,
        loginSessionId: persisted.loginSessionId,
        nativeGeneration: persisted.nativeGeneration,
        revision: persisted.revision,
        snapshotSha256: heldInputLedgerDigest(persisted),
        persistedAt: new Date().toISOString(),
        durable: true,
      },
    }),
  })
}

const control = () => ({
  signal: AbortSignal.timeout(5_000),
  checkpoint: () => undefined,
})

type Fixture = {
  adapter: NativeBrokerAdapter
  rawResponses: Uint8Array[]
}

async function createFixture(mode: "up" | "held" | "revoke"): Promise<Fixture> {
  const process = new NativeProcessTransport(binary, mode === "up" ? [] : [mode])
  const rawResponses: Uint8Array[] = []
  const adapter = new NativeBrokerAdapter({
    host: {
      generation: {
        runtimeEpoch: generation.runtimeEpoch,
        loginSessionId: generation.loginSessionId,
      },
      runtimeBuildId: "runtime-domain-recovery-fixture",
      capabilities: {
        schemaVersion: "1",
        scope: "adapter",
        producerRef: "domain-recovery-fixture",
        capabilities: [],
      },
    },
    adapterInstanceRef: `domain-recovery-${mode}`,
    transport: {
      send: frame => process.send(frame),
      close: () => process.close(),
      async *packets(signal) {
        for await (const packet of process.packets(signal)) {
          if (packet.kind === "message" && packet.frame.channel === "domain-recovery" && packet.bytes !== undefined) {
            rawResponses.push(Uint8Array.from(packet.bytes))
          }
          yield packet
        }
      },
    },
    ledgerSink: {
      async persist() {
        throw new Error("Passive domain recovery не создаёт ledger")
      },
    },
    bindEvidence: () => ({
      publisher: {
        async publish() {
          throw new Error("Passive domain recovery не публикует target evidence")
        },
      },
      sourceResponses: { register: () => undefined },
    }),
  })
  await adapter.handshake({
    kind: "handshake",
    protocolVersion: "1",
    requestId: `handshake-${mode}`,
    runtimeEpoch: generation.runtimeEpoch,
    loginSessionId: generation.loginSessionId,
    runtimeBuildId: "runtime-domain-recovery-fixture",
    expectedNativeBuildId: "domain-recovery-fixture-build",
    requiredRecoveryDomainVersion: "1",
    capabilitySchemaVersion: "1",
  })
  return { adapter, rawResponses }
}

function assertRawResponse(raw: Uint8Array, expectedGrant: ReturnType<typeof grant>) {
  const frame = JSON.parse(new TextDecoder().decode(raw)) as { channel: unknown, payload: unknown }
  expect(frame.channel).toBe("domain-recovery")
  const parsed = nativeDomainRecoveryResponseSchema.parse(frame.payload)
  expect(parsed.grantSha256).toBe(recoveryValueSha256(expectedGrant))
  expect(parsed.descriptorSha256).toBe(expectedGrant.descriptorSha256)
  return parsed
}

test("Unicode text risk key0 проходит framed ALL-UP без fabricated ledger и после drain", async () => {
  const fixture = await createFixture("up")
  try {
    const first = request("domain-unicode-1", [{ kind: "key", code: 0 }])
    expect(first.ledger).toBeUndefined()
    const response = await fixture.adapter.domainRecovery(first, control())
    expect(response.entries).toEqual([{ kind: "key", code: 0, observed: "up" }])
    expect(() => verifyDomainRecoveryAllUp(first, response, "domain-recovery-fixture-build", new Date())).not.toThrow()
    expect(assertRawResponse(fixture.rawResponses[0]!, first.grant)).toEqual(response)
    expect(new TextDecoder().decode(fixture.rawResponses[0]!)).not.toContain(historicalUnicodeContext)

    fixture.adapter.sealForRotation()
    const drained = await fixture.adapter.drain({
      requestId: "drain-domain-recovery",
      ...generation,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    }, control())
    expect(drained).toMatchObject({ cleanup: "complete", activeOperationIds: [] })
    const afterDrain = request("domain-after-drain", [{ kind: "key", code: 0 }])
    const afterResponse = await fixture.adapter.domainRecovery(afterDrain, control())
    expect(afterResponse.entries).toEqual([{ kind: "key", code: 0, observed: "up" }])
    expect(() => verifyDomainRecoveryAllUp(
      afterDrain,
      afterResponse,
      "domain-recovery-fixture-build",
      new Date(),
    )).not.toThrow()
    expect(assertRawResponse(fixture.rawResponses[1]!, afterDrain.grant)).toEqual(afterResponse)
  } finally {
    await fixture.adapter.close()
  }
})

test("held state сохраняется в raw response и не проходит ALL-UP verifier", async () => {
  const fixture = await createFixture("held")
  try {
    const source = request("domain-held", [{ kind: "key", code: 0 }])
    const response = await fixture.adapter.domainRecovery(source, control())
    expect(response.entries).toEqual([{ kind: "key", code: 0, observed: "held" }])
    expect(response.reason).toContain("принадлежность неизвестна")
    expect(() => verifyDomainRecoveryAllUp(
      source,
      response,
      "domain-recovery-fixture-build",
      new Date(),
    )).toThrow()
    expect(assertRawResponse(fixture.rawResponses[0]!, source.grant)).toEqual(response)
  } finally {
    await fixture.adapter.close()
  }
})

test("partial shortcut ledger не сужает полный descriptor risk set", async () => {
  const fixture = await createFixture("up")
  try {
    const persisted = ledger([
      { sequence: 1, kind: "key", code: 7, state: "confirmed-down" },
    ])
    const source = request("domain-shortcut", [
      { kind: "key", code: 7 },
      { kind: "key", code: 42 },
    ], persisted)
    const response = await fixture.adapter.domainRecovery(source, control())
    expect(response.entries).toEqual([
      { kind: "key", code: 7, observed: "up" },
      { kind: "key", code: 42, observed: "up" },
    ])
    expect(() => verifyDomainRecoveryAllUp(
      source,
      response,
      "domain-recovery-fixture-build",
      new Date(),
    )).not.toThrow()
    expect(assertRawResponse(fixture.rawResponses[0]!, source.grant)).toEqual(response)
  } finally {
    await fixture.adapter.close()
  }
})

test("readiness revocation превращает весь sampled batch в unknown", async () => {
  const fixture = await createFixture("revoke")
  try {
    const source = request("domain-revoke", [
      { kind: "key", code: 7 },
      { kind: "key", code: 42 },
    ])
    const response = await fixture.adapter.domainRecovery(source, control())
    expect(response.entries).toEqual([
      { kind: "key", code: 7, observed: "unknown" },
      { kind: "key", code: 42, observed: "unknown" },
    ])
    expect(response.secureInput).toBe("on")
    expect(() => verifyDomainRecoveryAllUp(
      source,
      response,
      "domain-recovery-fixture-build",
      new Date(),
    )).toThrow()
    expect(assertRawResponse(fixture.rawResponses[0]!, source.grant)).toEqual(response)
  } finally {
    await fixture.adapter.close()
  }
})
