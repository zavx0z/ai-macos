import {readFile} from "node:fs/promises"
import {homedir} from "node:os"
import {join} from "node:path"
import {spawn} from "bun"
import {isRunning} from "./chrome.ts"

export type ChromeProfile = {
  directory: string
  name: string
}

export type ChromeSessionRequest = {
  profileDirectory?: string
}

export type ChromeSessionResult =
  | {status: "ready"; running: true; launched: false}
  | {status: "ready"; running: true; launched: true; profile: ChromeProfile}
  | {status: "choice_required"; reason: "chrome_profile"; profiles: ChromeProfile[]}
  | {status: "invalid_profile"; reason: "chrome_profile_not_found"; profileDirectory: string; profiles: ChromeProfile[]}
  | {status: "unavailable"; reason: "chrome_profiles_not_found"; profiles: []}

type ChromeSessionDeps = {
  isRunning(): Promise<boolean>
  listProfiles(): Promise<ChromeProfile[]>
  launchProfile(profile: ChromeProfile): Promise<void>
}

const DEFAULT_LOCAL_STATE = join(homedir(), "Library", "Application Support", "Google", "Chrome", "Local State")

export async function listChromeProfiles(localStatePath = DEFAULT_LOCAL_STATE): Promise<ChromeProfile[]> {
  const text = await readFile(localStatePath, "utf8")
  return chromeProfilesFromLocalState(JSON.parse(text) as unknown)
}

export function chromeProfilesFromLocalState(value: unknown): ChromeProfile[] {
  if (!isRecord(value)) return []
  const profile = isRecord(value["profile"]) ? value["profile"] : undefined
  const cache = isRecord(profile?.["info_cache"]) ? profile["info_cache"] : undefined
  if (cache === undefined) return []

  const profiles: ChromeProfile[] = []
  for (const [directory, raw] of Object.entries(cache)) {
    if (!isRecord(raw) || raw["is_omitted"] === true) continue
    const name = typeof raw["name"] === "string" && raw["name"].trim().length > 0
      ? raw["name"].trim()
      : directory
    profiles.push({directory, name})
  }
  return profiles.sort((a, b) => profileSortKey(a.directory).localeCompare(profileSortKey(b.directory)))
}

export async function ensureChromeSession(
  request: ChromeSessionRequest = {},
  deps: ChromeSessionDeps = {
    isRunning,
    listProfiles: listChromeProfiles,
    launchProfile: launchChromeProfile,
  },
): Promise<ChromeSessionResult> {
  if (await deps.isRunning()) return {status: "ready", running: true, launched: false}

  const profiles = await deps.listProfiles()
  if (profiles.length === 0) return {status: "unavailable", reason: "chrome_profiles_not_found", profiles: []}

  const requested = request.profileDirectory?.trim()
  if (!requested) {
    return {status: "choice_required", reason: "chrome_profile", profiles}
  }

  const profile = profiles.find((candidate) => candidate.directory === requested)
  if (profile === undefined) {
    return {
      status: "invalid_profile",
      reason: "chrome_profile_not_found",
      profileDirectory: requested,
      profiles,
    }
  }

  await deps.launchProfile(profile)
  return {status: "ready", running: true, launched: true, profile}
}

export async function launchChromeProfile(profile: ChromeProfile): Promise<void> {
  const proc = spawn([
    "open",
    "-a",
    "Google Chrome",
    "--args",
    `--profile-directory=${profile.directory}`,
  ], {stdout: "pipe", stderr: "pipe"})
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`failed to launch Google Chrome profile ${profile.directory}: ${stderr.trim() || `open exited ${code}`}`)

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await isRunning()) return
    await Bun.sleep(100)
  }
  throw new Error(`Google Chrome did not start for profile ${profile.directory}`)
}

function profileSortKey(directory: string): string {
  if (directory === "Default") return "00000000"
  const match = /^Profile (\d+)$/.exec(directory)
  return match === null ? `2:${directory}` : `1:${String(Number(match[1])).padStart(8, "0")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
