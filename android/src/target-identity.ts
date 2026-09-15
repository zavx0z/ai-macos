import type { CdpTarget } from "@meta/shared"

export function selectCreatedTarget(
  previousTargetIds: ReadonlySet<string>,
  currentTargets: readonly CdpTarget[],
): CdpTarget | null {
  const created = currentTargets.filter(
    target => target.type === "page" && !previousTargetIds.has(target.id),
  )
  if (created.length > 1) {
    throw new Error(`Android target creation is ambiguous: ${created.map(target => target.id).join(", ")}`)
  }
  return created[0] ?? null
}
