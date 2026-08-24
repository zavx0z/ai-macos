import {describe, expect, test} from "bun:test"
import {chromeProfilesFromLocalState, ensureChromeSession, type ChromeProfile} from "./session.ts"

const PROFILES: ChromeProfile[] = [
  {directory: "Default", name: "Personal"},
  {directory: "Profile 2", name: "Work"},
]

describe("Chrome session profile selection", () => {
  test("exposes only launch-safe profile metadata", () => {
    expect(chromeProfilesFromLocalState({
      profile: {
        info_cache: {
          "Profile 2": {name: "Work", user_name: "secret@example.com"},
          Default: {name: "Personal", gaia_id: "secret"},
          "Profile 3": {name: "Hidden", is_omitted: true},
        },
      },
    })).toEqual(PROFILES)
  })

  test("uses an already-running Chrome without asking or launching", async () => {
    let launches = 0
    const result = await ensureChromeSession({}, {
      isRunning: async () => true,
      listProfiles: async () => { throw new Error("profiles should not be read") },
      launchProfile: async () => { launches += 1 },
    })
    expect(result).toEqual({status: "ready", running: true, launched: false})
    expect(launches).toBe(0)
  })

  test("requires an explicit choice when Chrome is closed", async () => {
    let launches = 0
    const result = await ensureChromeSession({}, {
      isRunning: async () => false,
      listProfiles: async () => PROFILES,
      launchProfile: async () => { launches += 1 },
    })
    expect(result).toEqual({status: "choice_required", reason: "chrome_profile", profiles: PROFILES})
    expect(launches).toBe(0)
  })

  test("still requires a choice when there is only one profile", async () => {
    const one = [PROFILES[0]!]
    expect(await ensureChromeSession({}, {
      isRunning: async () => false,
      listProfiles: async () => one,
      launchProfile: async () => { throw new Error("must not launch") },
    })).toEqual({status: "choice_required", reason: "chrome_profile", profiles: one})
  })

  test("launches exactly the explicitly selected profile", async () => {
    const launched: ChromeProfile[] = []
    const result = await ensureChromeSession({profileDirectory: "Profile 2"}, {
      isRunning: async () => false,
      listProfiles: async () => PROFILES,
      launchProfile: async (profile) => { launched.push(profile) },
    })
    expect(launched).toEqual([{directory: "Profile 2", name: "Work"}])
    expect(result).toEqual({status: "ready", running: true, launched: true, profile: PROFILES[1]})
  })

  test("never falls back when the selected profile is invalid", async () => {
    let launches = 0
    const result = await ensureChromeSession({profileDirectory: "Profile 999"}, {
      isRunning: async () => false,
      listProfiles: async () => PROFILES,
      launchProfile: async () => { launches += 1 },
    })
    expect(result).toEqual({
      status: "invalid_profile",
      reason: "chrome_profile_not_found",
      profileDirectory: "Profile 999",
      profiles: PROFILES,
    })
    expect(launches).toBe(0)
  })
})
