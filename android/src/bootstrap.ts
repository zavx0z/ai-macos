import { adbAvailable, adbDevices, type AdbDevice } from "./adb.ts"

export type BootstrapStatus = {
  profile: "android.chrome"
  enabled: boolean
  adb: boolean
  packageManager: "port" | null
  devices: AdbDevice[]
  device: AdbDevice | null
  forward: false
  cdp: false
  error?: string
  hint?: string
}

export type BootstrapRequest = {
  enabled?: boolean
  serial?: string
}

export type BootstrapDeps = {
  adbAvailable(): Promise<boolean>
  adbDevices(): Promise<AdbDevice[]>
}

/**
 * Пассивная проверка opt-in профиля Android Chrome.
 * Она не устанавливает ADB, не запускает и не перезапускает общий daemon,
 * не создаёт forward и не выбирает первое устройство.
 */
export async function bootstrap(
  request: BootstrapRequest = {},
  deps: BootstrapDeps = { adbAvailable, adbDevices },
): Promise<BootstrapStatus> {
  const base = {
    profile: "android.chrome" as const,
    enabled: request.enabled === true,
    packageManager: null,
    devices: [] as AdbDevice[],
    device: null,
    forward: false as const,
    cdp: false as const,
  }
  if (!base.enabled) {
    return {
      ...base,
      adb: false,
      hint: "Профиль android.chrome выключен; ADB не проверялся, подключение требует enabled:true и точный serial",
    }
  }

  if (!(await deps.adbAvailable())) {
    return {
      ...base,
      adb: false,
      packageManager: "port",
      error: "adb-not-installed",
      hint: "ADB устанавливается отдельным setup через MacPorts: сначала port version и port installed android-platform-tools, затем sudo port install android-platform-tools",
    }
  }

  let devices: AdbDevice[]
  try {
    devices = await deps.adbDevices()
  } catch (error) {
    return {
      ...base,
      adb: true,
      error: error instanceof Error ? error.message : String(error),
      hint: "Общий ADB daemon не перезапускается автоматически; проверьте его отдельно",
    }
  }

  const serial = request.serial?.trim()
  if (!serial) {
    return {
      ...base,
      adb: true,
      devices,
      error: "serial-required",
      hint: "Передайте точный serial из списка devices",
    }
  }

  const device = devices.find((candidate) => candidate.serial === serial) ?? null
  if (!device) {
    return {
      ...base,
      adb: true,
      devices,
      error: "device-not-found",
      hint: `Устройство с serial=${serial} не найдено; fallback на другое устройство запрещён`,
    }
  }
  if (device.state !== "device") {
    return {
      ...base,
      adb: true,
      devices,
      device,
      error: `device-${device.state}`,
      hint: `Устройство ${serial} находится в состоянии ${device.state}`,
    }
  }

  return {
    ...base,
    adb: true,
    devices,
    device,
    hint: "Пассивная проверка завершена; forward создаётся отдельным owned connect",
  }
}
