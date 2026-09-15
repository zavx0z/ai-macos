import { resolve } from "node:path"
import {
  acceptanceScenarios,
  type AcceptanceEvidence,
  type AcceptanceScenario
} from "./matrix"

export type AcceptanceProfileStatus = "pass" | "fail" | "not-run"

export type AcceptanceProbeId = "contracts" | "native" | "runtime" | "host-mcp"

export interface AcceptanceProbeOutcome {
  probeId: AcceptanceProbeId
  status: "pass" | "fail"
  durationMs: number
  command: string
  outputTail?: string
}

interface ScenarioProbeLink {
  probeId: AcceptanceProbeId
  scenarioId: AcceptanceScenario["id"]
  evidenceRef: string
  satisfies: AcceptanceEvidence[]
  note: string
}

export const acceptanceProfileProbes: Array<{
  probeId: AcceptanceProbeId
  path: string
}> = [
  { probeId: "contracts", path: "tests/computer-use/contracts-sut.test.ts" },
  { probeId: "native", path: "tests/computer-use/native-sut.test.ts" },
  { probeId: "runtime", path: "tests/computer-use/runtime-sut.test.ts" },
  { probeId: "host-mcp", path: "tests/computer-use/host-mcp-sut.test.ts" }
]

const scenarioProbeLinks: ScenarioProbeLink[] = [
  { probeId: "contracts", scenarioId: "A01", evidenceRef: "contracts-sut.test.ts#A01", satisfies: ["contract"], note: "Handshake compatibility; live mismatch остаётся отдельно" },
  { probeId: "contracts", scenarioId: "A08", evidenceRef: "contracts-sut.test.ts#A08", satisfies: [], note: "Schema guard дополняет native fault injection" },
  { probeId: "contracts", scenarioId: "A10", evidenceRef: "contracts-sut.test.ts#A10", satisfies: [], note: "Schema generation guard дополняет native fence" },
  { probeId: "contracts", scenarioId: "A11", evidenceRef: "contracts-sut.test.ts#A11", satisfies: ["contract"], note: "Payload receipt и no-replay error contract" },
  { probeId: "contracts", scenarioId: "A38", evidenceRef: "contracts-sut.test.ts#A38", satisfies: [], note: "Capability schema, не integration" },
  { probeId: "native", scenarioId: "A04", evidenceRef: "native-sut.test.ts#A04", satisfies: ["fault-injection"], note: "Target checkpoint; live focus steal не запускался" },
  { probeId: "native", scenarioId: "A06", evidenceRef: "native-sut.test.ts#A06", satisfies: ["native-fixture"], note: "Cancel до первого event" },
  { probeId: "native", scenarioId: "A07", evidenceRef: "native-sut.test.ts#A07", satisfies: ["native-fixture"], note: "Matching up; live часть не запускалась" },
  { probeId: "native", scenarioId: "A08", evidenceRef: "native-sut.test.ts#A08", satisfies: ["fault-injection"], note: "Lost ACK и обе persistence ветви" },
  { probeId: "native", scenarioId: "A09", evidenceRef: "native-sut.test.ts#A09", satisfies: ["fault-injection"], note: "Watchdog и recovery ledger" },
  { probeId: "native", scenarioId: "A10", evidenceRef: "native-sut.test.ts#A10", satisfies: ["native-fixture"], note: "Epoch/login/native fence high-water" },
  { probeId: "native", scenarioId: "A16", evidenceRef: "native-sut.test.ts#A16", satisfies: ["native-fixture"], note: "2 AX к 1 CG ambiguous; live часть не запускалась" },
  { probeId: "runtime", scenarioId: "A03", evidenceRef: "runtime-sut.test.ts#A03", satisfies: ["integration"], note: "Два real Runtime client sessions и один desktop resource" },
  { probeId: "runtime", scenarioId: "A05", evidenceRef: "runtime-sut.test.ts#A05", satisfies: [], note: "Runtime deadline/cancel ACK; actual UDS caller timeout открыт" },
  { probeId: "runtime", scenarioId: "A11", evidenceRef: "runtime-sut.test.ts#A11", satisfies: [], note: "Resumption/dedup дополняет contract evidence" },
  { probeId: "runtime", scenarioId: "A42", evidenceRef: "runtime-sut.test.ts#A42", satisfies: [], note: "Quarantine проверен; durable retention/restart открыт" },
  { probeId: "host-mcp", scenarioId: "A31", evidenceRef: "host-mcp-sut.test.ts#unavailable-dispatch", satisfies: [], note: "Capability gate проверен; forged peer/socket auth открыт" },
  { probeId: "host-mcp", scenarioId: "A38", evidenceRef: "host-mcp-sut.test.ts#core-without-native", satisfies: ["integration"], note: "RuntimeHost и MCP работают без native optional capabilities" },
  { probeId: "host-mcp", scenarioId: "A41", evidenceRef: "host-mcp-sut.test.ts#frame-lineage", satisfies: [], note: "Frame lineage isolation; action/latest contract открыт" },
  { probeId: "host-mcp", scenarioId: "A42", evidenceRef: "host-mcp-sut.test.ts#bounded-drain", satisfies: [], note: "Bounded drain; durable retention/restart открыт" },
  { probeId: "host-mcp", scenarioId: "A43", evidenceRef: "host-mcp-sut.test.ts#catalogChanged", satisfies: [], note: "Dynamic MCP notification in-process; fresh task client-live открыт" }
]

export function buildAcceptanceProfile(outcomes: AcceptanceProbeOutcome[]) {
  const byProbe = new Map(outcomes.map((outcome) => [outcome.probeId, outcome]))
  const scenarios = acceptanceScenarios.map((scenario) => {
    const links = scenarioProbeLinks.filter((link) => link.scenarioId === scenario.id)
    const evidence = links.map((link) => {
      const outcome = byProbe.get(link.probeId)
      return {
        probeId: link.probeId,
        evidenceRef: link.evidenceRef,
        outcome: outcome?.status ?? "not-run",
        satisfies: link.satisfies,
        note: link.note
      }
    })
    const failed = evidence.some((item) => item.outcome === "fail")
    const satisfied = new Set(
      evidence
        .filter((item) => item.outcome === "pass")
        .flatMap((item) => item.satisfies)
    )
    const missingEvidence = scenario.evidence.filter((kind) => !satisfied.has(kind))
    const status: AcceptanceProfileStatus = failed
      ? "fail"
      : missingEvidence.length === 0
        ? "pass"
        : "not-run"
    return {
      id: scenario.id,
      title: scenario.title,
      status,
      requiredEvidence: scenario.evidence,
      missingEvidence,
      evidence
    }
  })
  return {
    profile: "computer-use-safe-acceptance",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: outcomes,
    summary: {
      pass: scenarios.filter((scenario) => scenario.status === "pass").length,
      fail: scenarios.filter((scenario) => scenario.status === "fail").length,
      notRun: scenarios.filter((scenario) => scenario.status === "not-run").length
    },
    scenarios
  }
}

async function runProbe(
  repositoryRoot: string,
  probe: (typeof acceptanceProfileProbes)[number]
): Promise<AcceptanceProbeOutcome> {
  const command = `bun test ${probe.path}`
  const startedAt = performance.now()
  const child = Bun.spawn([process.execPath, "test", probe.path], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const combined = `${stdout}\n${stderr}`.trim()
  return {
    probeId: probe.probeId,
    status: exitCode === 0 ? "pass" : "fail",
    durationMs: Math.round(performance.now() - startedAt),
    command,
    ...(exitCode === 0
      ? {}
      : { outputTail: combined.slice(Math.max(0, combined.length - 4000)) })
  }
}

export async function runAcceptanceProfile() {
  const repositoryRoot = resolve(import.meta.dir, "../..")
  const outcomes: AcceptanceProbeOutcome[] = []
  for (const probe of acceptanceProfileProbes) {
    outcomes.push(await runProbe(repositoryRoot, probe))
  }
  return buildAcceptanceProfile(outcomes)
}

if (import.meta.main) {
  const profile = await runAcceptanceProfile()
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
  if (profile.summary.fail > 0) process.exitCode = 1
}
