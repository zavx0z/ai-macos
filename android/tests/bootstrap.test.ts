import { describe, expect, test } from "bun:test"
import { bootstrap, type BootstrapDeps } from "../src/bootstrap.ts"

const devices = [
  { serial: "phone-a", state: "device" },
  { serial: "phone-b", state: "device" },
]

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    adbAvailable: async () => true,
    adbDevices: async () => devices,
    ...overrides,
  }
}

describe("Android opt-in bootstrap", () => {
  test("не обращается к списку устройств у выключенного профиля", async () => {
    let availabilityCalls = 0
    let inventoryCalls = 0
    const result = await bootstrap({}, deps({
      adbAvailable: async () => {
        availabilityCalls += 1
        return true
      },
      adbDevices: async () => {
        inventoryCalls += 1
        return devices
      },
    }))

    expect(result.enabled).toBe(false)
    expect(result.cdp).toBe(false)
    expect(availabilityCalls).toBe(0)
    expect(inventoryCalls).toBe(0)
  })

  test("не выбирает первое из нескольких устройств", async () => {
    const result = await bootstrap({ enabled: true }, deps())

    expect(result.device).toBeNull()
    expect(result.error).toBe("serial-required")
    expect(result.devices).toEqual(devices)
  })

  test("не подменяет отсутствующий serial другим устройством", async () => {
    const result = await bootstrap({ enabled: true, serial: "missing" }, deps())

    expect(result.device).toBeNull()
    expect(result.error).toBe("device-not-found")
  })

  test("не запускает установку при отсутствующем adb", async () => {
    const result = await bootstrap({ enabled: true, serial: "phone-a" }, deps({
      adbAvailable: async () => false,
      adbDevices: async () => { throw new Error("inventory must not run") },
    }))

    expect(result).toMatchObject({
      adb: false,
      packageManager: "port",
      error: "adb-not-installed",
    })
    expect(result.hint).toContain("MacPorts")
    expect(result.hint).not.toContain("brew")
  })
})
