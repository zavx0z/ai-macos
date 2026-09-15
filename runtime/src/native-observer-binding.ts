import type { ObservedEvent, ObserverCoverage } from "@meta/shared/contracts"
import {
  nativeObserverRequestSchema,
  nativeObserverResponseSchema,
  nativeObserverResponseMatches,
  type NativeObserverSnapshot,
} from "@meta/native/protocol"
import {
  RuntimeNativeObserverHub,
  type NativeObserverClient,
} from "./observer-hub.ts"

const OBSERVER_CONTROL_MS = 1_000
const OBSERVER_PREPARE_MS = 6_000

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
  signal?: AbortSignal
}): Promise<NativeObserverBinding> {
  options.signal?.throwIfAborted()
  const generation = options.native.generation
  if (generation === undefined) throw new Error("Native observer handshake не завершён")
  const prepare = nativeObserverRequestSchema.parse({
    kind: "observer",
    protocolVersion: "1",
    requestId: `observer-prepare:${crypto.randomUUID()}`,
    ...generation,
    command: "prepare",
    deadlineAt: new Date(Date.now() + OBSERVER_PREPARE_MS).toISOString(),
  })
  const prepareController = new AbortController()
  const onCallerAbort = () => prepareController.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onCallerAbort, { once: true })
  if (options.signal?.aborted) onCallerAbort()
  const prepareTimer = setTimeout(
    () => prepareController.abort("observer prepare deadline"),
    OBSERVER_PREPARE_MS,
  )
  const preparing = Promise.resolve().then(async () => {
    prepareController.signal.throwIfAborted()
    const response = nativeObserverResponseSchema.parse(await options.native.observer(prepare, {
      signal: prepareController.signal,
      checkpoint: () => { prepareController.signal.throwIfAborted() },
    }))
    if (!nativeObserverResponseMatches(prepare, response, options.native.loadedBuildId)) throw new Error("Observer prepare response не соответствует request/binding")
    return response
  })
  let snapshot: NativeObserverSnapshot | undefined
  try {
    const response = await settle(preparing, OBSERVER_PREPARE_MS, "observer prepare", prepareController.signal)
    if (!response.ok) throw new Error(response.error.message)
    snapshot = structuredClone(response.snapshot)
    prepareController.signal.throwIfAborted()
  } catch (error) {
    if (snapshot !== undefined) {
      await stopObserver(options.native, snapshot.observerInstanceRef).catch(cause => {
        options.onGap?.(new Error("Observer cleanup после отмены не подтверждён", { cause }))
      })
    } else {
      void preparing.then(async response => {
        if (!response.ok) return
        await stopObserver(options.native, response.snapshot.observerInstanceRef).catch(cause => {
          options.onGap?.(new Error("Late observer cleanup не подтверждён", { cause }))
        })
      }, () => undefined)
    }
    throw error
  } finally {
    clearTimeout(prepareTimer)
    options.signal?.removeEventListener("abort", onCallerAbort)
  }

  let hub: RuntimeNativeObserverHub
  try {
    options.signal?.throwIfAborted()
    hub = new RuntimeNativeObserverHub({
      native: options.native,
      snapshot,
      onGap: options.onGap,
    })
    hub.start()
  } catch (error) {
    try {
      await stopObserver(options.native, snapshot.observerInstanceRef)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Observer startup и cleanup не подтверждены")
    }
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

async function settle<T>(promise: Promise<T>, timeoutMs: number, stage: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error(`${stage} отменён`))
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) onAbort()
        timer = setTimeout(() => reject(new Error(`${stage} не завершён bounded`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}
