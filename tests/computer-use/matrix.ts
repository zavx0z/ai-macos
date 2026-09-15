export type AcceptanceEvidence =
  | "contract"
  | "integration"
  | "fault-injection"
  | "native-fixture"
  | "browser-fixture"
  | "live"
  | "device-live"
  | "installation-live"
  | "client-live"

export interface AcceptanceScenario {
  id: `A${number}`
  title: string
  evidence: AcceptanceEvidence[]
  prerequisite: "C1" | "C2" | "C3" | "C4" | "native-live" | "device-live"
}

export type AcceptanceSutEvidence =
  | "contract-parser"
  | "native-c"
  | "runtime-core"
  | "runtime-host-mcp"

// Это реестр приёмки, а не production API и не доказательство полной готовности сценария.
export const acceptanceScenarios: AcceptanceScenario[] = [
  { id: "A01", title: "Несовместимая версия backend", evidence: ["contract", "live"], prerequisite: "C1" },
  { id: "A02", title: "Конкурентный startup MCP", evidence: ["integration"], prerequisite: "C2" },
  { id: "A03", title: "Два независимых input-клиента", evidence: ["integration"], prerequisite: "C2" },
  { id: "A04", title: "Кража focus перед native step", evidence: ["fault-injection", "live"], prerequisite: "native-live" },
  { id: "A05", title: "Caller timeout при долгом dispatch", evidence: ["integration"], prerequisite: "C2" },
  { id: "A06", title: "Cancel до первого события", evidence: ["native-fixture"], prerequisite: "C2" },
  { id: "A07", title: "Cancel после synthetic down", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A08", title: "SIGKILL между down и ledger ACK", evidence: ["fault-injection"], prerequisite: "C2" },
  { id: "A09", title: "Runtime crash при живом helper", evidence: ["fault-injection"], prerequisite: "C2" },
  { id: "A10", title: "Старый fence после restart", evidence: ["native-fixture"], prerequisite: "C2" },
  { id: "A11", title: "Потерянный reply и повтор request ID", evidence: ["contract"], prerequisite: "C1" },
  { id: "A12", title: "User takeover во время interaction", evidence: ["live"], prerequisite: "native-live" },
  { id: "A13", title: "Observer unavailable или revoked", evidence: ["contract", "live"], prerequisite: "native-live" },
  { id: "A14", title: "Невидимые и other-Space окна", evidence: ["live"], prerequisite: "native-live" },
  { id: "A15", title: "Пустой, partial и denied inventory", evidence: ["contract", "live"], prerequisite: "C3" },
  { id: "A16", title: "Неоднозначное сопоставление CG и AX", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A17", title: "Повтор PID или CG ID", evidence: ["native-fixture"], prerequisite: "C2" },
  { id: "A18", title: "AX-only окно", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A19", title: "Sheet и popup Save/Open", evidence: ["live"], prerequisite: "native-live" },
  { id: "A20", title: "Многошаговый browser interaction", evidence: ["live"], prerequisite: "C4" },
  { id: "A21", title: "Composite capture с overlay", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A22", title: "Isolated capture защищённого контента", evidence: ["live"], prerequisite: "native-live" },
  { id: "A23", title: "Mixed DPI, origins и rotation", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A24", title: "Window spans displays", evidence: ["live"], prerequisite: "native-live" },
  { id: "A25", title: "Observation stale после geometry change", evidence: ["fault-injection", "live"], prerequisite: "C3" },
  { id: "A26", title: "SCStream frame lifecycle", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A27", title: "Unicode, layout и modifiers", evidence: ["live"], prerequisite: "native-live" },
  { id: "A28", title: "Anchor scroll и trajectory drag", evidence: ["live"], prerequisite: "native-live" },
  { id: "A29", title: "Partial move и resize", evidence: ["contract", "live"], prerequisite: "C3" },
  { id: "A30", title: "Unsaved close и quit", evidence: ["live"], prerequisite: "native-live" },
  { id: "A31", title: "Недоверенный mutation transport", evidence: ["integration"], prerequisite: "C2" },
  { id: "A32", title: "Утраченные permissions", evidence: ["contract", "live"], prerequisite: "native-live" },
  { id: "A33", title: "Permission identity после helper update", evidence: ["installation-live"], prerequisite: "native-live" },
  { id: "A34", title: "Одинаковые URL в разных profiles", evidence: ["contract", "live"], prerequisite: "C4" },
  { id: "A35", title: "Строгая browser readiness", evidence: ["browser-fixture"], prerequisite: "C4" },
  { id: "A36", title: "Browser hang и disconnect", evidence: ["browser-fixture"], prerequisite: "C4" },
  { id: "A37", title: "Лимиты full-page и viewport", evidence: ["contract"], prerequisite: "C4" },
  { id: "A38", title: "Core без optional adapters", evidence: ["integration"], prerequisite: "C2" },
  { id: "A39", title: "Несколько Android devices и reconnect", evidence: ["device-live"], prerequisite: "device-live" },
  { id: "A40", title: "Android target, capture и reload", evidence: ["browser-fixture", "device-live"], prerequisite: "device-live" },
  { id: "A41", title: "Action capture и client-scoped cache", evidence: ["contract"], prerequisite: "C3" },
  { id: "A42", title: "Disconnect, lease expiry и journal pressure", evidence: ["fault-injection"], prerequisite: "C2" },
  { id: "A43", title: "MCP reconnect и tool catalog", evidence: ["client-live"], prerequisite: "C4" },
  { id: "A44", title: "Sleep, wake и login session", evidence: ["native-fixture", "live"], prerequisite: "native-live" },
  { id: "A45", title: "Slow AX при cancel и health", evidence: ["fault-injection"], prerequisite: "C3" }
]

export const acceptanceSutEvidence: Partial<
  Record<AcceptanceScenario["id"], AcceptanceSutEvidence[]>
> = {
  A01: ["contract-parser"],
  A03: ["runtime-core"],
  A04: ["native-c"],
  A05: ["runtime-core"],
  A06: ["native-c"],
  A07: ["native-c"],
  A08: ["contract-parser", "native-c"],
  A09: ["native-c"],
  A10: ["contract-parser", "native-c"],
  A11: ["contract-parser", "runtime-core"],
  A16: ["native-c"],
  A38: ["contract-parser", "runtime-host-mcp"],
  A41: ["runtime-host-mcp"],
  A42: ["runtime-core", "runtime-host-mcp"],
  A43: ["runtime-host-mcp"]
}
