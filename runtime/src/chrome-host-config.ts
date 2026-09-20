import { CdpHttp } from "@meta/shared"
import type { BrowserProvenance, RuntimeProcessRef } from "@meta/shared/contracts"
import { CdpBrowserDriver, type BrowserDriver } from "@meta/chrome/adapter"
import { ExistingChromeDriver } from "@meta/chrome/existing-session"
import { lifetimeConfigFingerprint, type LifetimeBindingPersistence } from "./lifetime-state.ts"

type ChromeInstanceBase = {
  browserInstanceRef: string
  initialTransportGeneration: string
  profileLabel?: string
  process?: RuntimeProcessRef
  driver?: BrowserDriver
}

export type ChromeInstanceConfig = ChromeInstanceBase & (
  | {
    connectionMode?: "http"
    endpointHost: "127.0.0.1" | "localhost" | "::1"
    endpointPort: number
    profilePath: string
  }
  | {
    connectionMode: "existing-session"
    userDataDir: string
    approvalTimeoutMs?: number
  }
)

export function chromeDriver(item: ChromeInstanceConfig): BrowserDriver {
  if (item.driver) return item.driver
  return item.connectionMode === "existing-session"
    ? new ExistingChromeDriver({ userDataDir: item.userDataDir, approvalTimeoutMs: item.approvalTimeoutMs })
    : new CdpBrowserDriver(new CdpHttp(item.endpointHost, item.endpointPort))
}

export function chromeProvenance(item: ChromeInstanceConfig): BrowserProvenance {
  // The user-managed endpoint has an opaque configured reference, not a fictitious fixed port.
  // Its concrete address is discovered only during the explicit connection operation.
  return item.connectionMode === "existing-session"
    ? { kind: "external-cdp", endpointRef: item.browserInstanceRef }
    : { kind: "local-cdp", endpointHost: item.endpointHost, endpointPort: item.endpointPort, profilePath: item.profilePath }
}

export function chromePersistence(item: ChromeInstanceConfig): LifetimeBindingPersistence {
  const physicalOwnershipKey = item.connectionMode === "existing-session"
    ? { kind: "chrome-user-session" as const, userDataDir: item.userDataDir }
    : { kind: "chrome-cdp" as const, endpointHost: item.endpointHost, endpointPort: item.endpointPort, profilePath: item.profilePath }
  const fingerprint = item.connectionMode === "existing-session"
    ? { connectionMode: item.connectionMode, userDataDir: item.userDataDir }
    : { endpointHost: item.endpointHost, endpointPort: item.endpointPort, profilePath: item.profilePath }
  return {
    owner: { kind: "browser", browserInstanceRef: item.browserInstanceRef },
    configFingerprint: lifetimeConfigFingerprint(fingerprint),
    physicalOwnershipKey,
  }
}
