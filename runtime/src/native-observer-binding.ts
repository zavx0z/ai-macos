import type { ObservedEvent, ObserverCoverage } from "@meta/shared/contracts"
import {
  nativeObserverRequestSchema,
  type NativeObserverSnapshot,
} from "@meta/native/protocol"
import {
  RuntimeNativeObserverHub,
  type NativeObserverClient,
} from "./observer-hub.ts"

const OBSERVER_CONTROL_MS = 1_000

export type NativeObserverBinding = Readonly<{
  hub: RuntimeNativeObserverHub
  snapshot: NativeObserverSnapshot
  coverage(signal?: AbortSignal): Promise<ObserverCoverage>
  events(signal: AbortSignal): AsyncIterable<ObservedEvent>
  close(): Promise<void>
}>

export async function createNativeObserverBinding(options: {
  native: NativeObserverClient
  onGap?: (error: Error) => void
}): Promise<NativeObserverBinding> {
  const generation = options.native.generation
  if (generation === undefined) throw new Error("Native observer handshake не завершён")
  const prepare = nativeObserverRequestSchema.parse({
    kind: "observer",
    protocolVersion: "1",
    requestId: `observer-prepare:${crypto.randomUUID()}`,
    ...generation,
    command: "prepare",
    deadlineAt: new Date(Date.now() + OBSERVER_CONTROL_MS).toISOString(),
  })
  const prepareController = new AbortController()
  const prepareTimer = setTimeout(
    () => prepareController.abort("observer prepare deadline"),
    OBSERVER_CONTROL_MS,
  )
  let snapshot: NativeObserverSnapshot
  try {
    const response = await settle(options.native.observer(prepare, {
      signal: prepareController.signal,
      checkpoint: () => { prepareController.signal.throwIfAborted() },
    }), OBSERVER_CONTROL_MS, "observer prepare")
    if (!response.ok) throw new Error(response.error.message)
    snapshot = structuredClone(response.snapshot)
  } finally {
    clearTimeout(prepareTimer)
  }

  const hub = new RuntimeNativeObserverHub({
    native: options.native,
    snapshot,
    onGap: options.onGap,
  })
  try {
    hub.start()
  } catch (error) {
    await stopObserver(options.native, snapshot.observerInstanceRef).catch(() => undefined)
    throw error
  }

  let closed = false
  let closing: Promise<void> | undefined
  return Object.freeze({
    hub,
    snapshot: deepFreeze(structuredClone(snapshot)),
    coverage: (signal?: AbortSignal) => hub.coverage(signal),
    events: (signal: AbortSignal) => hub.subscribe({ signal }),
    close: async () => {
      if (closed) return
      if (closing !== undefined) return await closing
      closing = (async () => {
        await hub.close()
        await stopObserver(options.native, snapshot.observerInstanceRef)
        closed = true
      })()
      try { await closing }
      finally { if (!closed) closing = undefined }
    },
  })
}

async function stopObserver(
  native: NativeObserverClient,
  observerInstanceRef: string,
): Promise<void> {
  const generation = native.generation
  if (generation === undefined) throw new Error("Native generation потеряна до observer stop")
  const request = nativeObserverRequestSchema.parse({
    kind: "observer",
    protocolVersion: "1",
    requestId: `observer-stop:${crypto.randomUUID()}`,
    ...generation,
    command: "stop",
    deadlineAt: new Date(Date.now() + OBSERVER_CONTROL_MS).toISOString(),
    observerInstanceRef,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("observer stop deadline"), OBSERVER_CONTROL_MS)
  try {
    const response = await settle(native.observer(request, {
      signal: controller.signal,
      checkpoint: () => { controller.signal.throwIfAborted() },
    }), OBSERVER_CONTROL_MS, "observer stop")
    if (!response.ok) throw new Error(response.error.message)
  } finally {
    clearTimeout(timer)
  }
}

async function settle<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} не завершён bounded`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}
