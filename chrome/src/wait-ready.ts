import { withSession, type CdpSession, type CdpTarget } from "@meta/shared"

export type WaitReadyOptions = {
  readyState?: boolean
  fonts?: boolean
  networkIdle?: boolean
  images?: boolean
  reflowStable?: boolean
  animations?: boolean
  finalCommit?: boolean
  idleMs?: number
  stepMs?: number
  maxMs?: number
}

export type WaitReadyStep = {
  name: string
  ok: boolean
  durationMs: number
  error?: string
}

export type WaitReadyResult = {
  ok: boolean
  status: "ready" | "partial" | "timed-out"
  reached: string[]
  skipped: string[]
  incomplete: string[]
  timedOut: boolean
  durationMs: number
  steps: WaitReadyStep[]
}

const DEFAULTS: Required<WaitReadyOptions> = {
  readyState: true,
  fonts: true,
  networkIdle: true,
  images: true,
  reflowStable: true,
  animations: true,
  finalCommit: true,
  idleMs: 700,
  stepMs: 8_000,
  maxMs: 15_000,
}

export async function waitFullyReady(target: CdpTarget, opts: WaitReadyOptions = {}): Promise<WaitReadyResult> {
  return await withSession(target, async (s) => waitOnSession(s, opts))
}

type NetworkEvent = { requestId?: string }

export type ReadinessTracker = {
  waitForNetworkIdle(idleMs: number, maxMs: number, signal: AbortSignal): Promise<void>
  close(): void
}

export async function armReadiness(
  session: CdpSession,
  opts: WaitReadyOptions = {},
): Promise<ReadinessTracker | null> {
  const options = { ...DEFAULTS, ...opts }
  if (!options.networkIdle) return null
  const inflight = new Set<string>()
  let anonymousInflight = 0
  let lastChange = Date.now()

  const begin = (event: NetworkEvent) => {
    if (event.requestId) inflight.add(event.requestId)
    else anonymousInflight += 1
    lastChange = Date.now()
  }
  const finish = (event: NetworkEvent) => {
    if (event.requestId) inflight.delete(event.requestId)
    else anonymousInflight = Math.max(0, anonymousInflight - 1)
    lastChange = Date.now()
  }
  const unsubscribers = [
    session.subscribe<NetworkEvent>("Network.requestWillBeSent", begin),
    session.subscribe<NetworkEvent>("Network.loadingFinished", finish),
    session.subscribe<NetworkEvent>("Network.loadingFailed", finish),
  ]
  try {
    await session.send("Network.enable")
  } catch (error) {
    for (const unsubscribe of unsubscribers) unsubscribe()
    throw error
  }

  return {
    async waitForNetworkIdle(idleMs, maxMs, signal) {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error("networkIdle aborted")
        if (inflight.size === 0 && anonymousInflight === 0 && Date.now() - lastChange >= idleMs) return
        await abortableDelay(50, signal)
      }
      throw new Error(`networkIdle did not settle within ${maxMs}ms`)
    },
    close() {
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  }
}

export async function waitOnSession(
  s: CdpSession,
  opts: WaitReadyOptions = {},
  armedTracker?: ReadinessTracker | null,
): Promise<WaitReadyResult> {
  const o = { ...DEFAULTS, ...opts }
  const t0 = Date.now()
  const reached: string[] = []
  const skipped: string[] = []
  const steps: WaitReadyStep[] = []
  const elapsed = () => Date.now() - t0
  const remaining = () => Math.max(0, o.maxMs - elapsed())

  const ownTracker = armedTracker === undefined
  const networkTracker = armedTracker === undefined ? await armReadiness(s, o) : armedTracker

  // Chrome throttles rAF/setTimeout/document.fonts.ready in non-focused tabs (down
  // to ~1 Hz). Emulation.setFocusEmulationEnabled makes the renderer believe the
  // page has focus — disables all throttling for our wait loop. Does NOT change
  // OS-level focus (Chrome stays wherever it was in the window stack).
  await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})

  const runStep = async (name: string, enabled: boolean, fn: (signal: AbortSignal) => Promise<unknown>) => {
    if (!enabled) { skipped.push(name); return }
    if (remaining() <= 0) { skipped.push(name); return }
    const budget = Math.max(50, Math.min(o.stepMs, remaining()))
    const sT = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      const value = await fn(controller.signal)
      if (value === false) throw new Error(`${name} predicate returned false`)
      steps.push({ name, ok: true, durationMs: Date.now() - sT })
      reached.push(name)
    } catch (e) {
      const error = controller.signal.aborted
        ? `${name} timeout after ${budget}ms`
        : e instanceof Error ? e.message : String(e)
      steps.push({ name, ok: false, durationMs: Date.now() - sT, error })
    } finally {
      clearTimeout(timer)
    }
  }

  await runStep("readyState", o.readyState, async (signal) => {
    // Poll document.readyState via plain Runtime.evaluate (no awaitPromise / no async
    // wrapper). After Page.reload the first async IIFE evaluate in a fresh session
    // sometimes hangs forever despite the context existing — a simple sync read is
    // bulletproof. We retry every 50 ms until 'complete' or the step budget runs out.
    const deadline = Date.now() + Math.max(50, Math.min(o.stepMs, remaining()))
    while (Date.now() < deadline) {
      const res = await s.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }, { signal })
      if (res.result.value === "complete") return
      await abortableDelay(50, signal)
    }
    throw new Error("readyState did not reach 'complete'")
  })

  await runStep("fonts", o.fonts, async (signal) => {
    return await pageEval(s, FONTS_JS, signal)
  })

  await runStep("networkIdle", o.networkIdle, async (signal) => {
    if (!networkTracker) throw new Error("networkIdle tracker was not armed")
    await networkTracker.waitForNetworkIdle(o.idleMs, remaining(), signal)
  })

  await runStep("images", o.images, async (signal) => {
    return await pageEval(s, IMAGES_JS, signal)
  })

  await runStep("reflowStable", o.reflowStable, async (signal) => {
    return await pageEval(s, REFLOW_STABLE_JS, signal)
  })

  await runStep("animations", o.animations, async (signal) => {
    return await pageEval(s, ANIMATIONS_JS, signal)
  })

  await runStep("finalCommit", o.finalCommit, async (signal) => {
    return await pageEval(s, FINAL_COMMIT_JS, signal)
  })

  if (ownTracker) networkTracker?.close()
  const incomplete = steps.filter((step) => !step.ok).map((step) => step.name)
  const timedOut = remaining() <= 0 || steps.some((step) => step.error?.includes("timeout"))
  const ok = incomplete.length === 0 && !timedOut
  return {
    ok,
    status: ok ? "ready" : timedOut ? "timed-out" : "partial",
    reached,
    skipped,
    incomplete,
    timedOut,
    durationMs: elapsed(),
    steps,
  }
}

async function pageEval(s: CdpSession, body: string, signal: AbortSignal): Promise<unknown> {
  const expression = `(async () => { ${body} })()`
  const res = await s.send<{
    result: { value?: unknown }
    exceptionDetails?: { exception?: { description?: string }; text?: string }
  }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { signal })
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS exception"
    throw new Error(msg)
  }
  return res.result.value
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted")
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const READY_STATE_JS = `
  // Poll instead of addEventListener('load') — avoids race condition where 'load'
  // already fired between our two reads. setTimeout is reliable here because
  // Emulation.setFocusEmulationEnabled was applied at session start.
  while (document.readyState !== 'complete') {
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
`

const FONTS_JS = `
  if (!document.fonts || typeof document.fonts.ready?.then !== 'function') return true;
  await document.fonts.ready;
  return true;
`

const IMAGES_JS = `
  const imgs = Array.from(document.images || []);
  for (const i of imgs) { try { i.loading = 'eager'; } catch {} }
  await Promise.all(imgs.map(i => {
    if (i.complete && i.naturalWidth > 0) return null;
    return new Promise(r => {
      const done = () => r(null);
      i.addEventListener('load', done, { once: true });
      i.addEventListener('error', done, { once: true });
      setTimeout(done, 5000);
    });
  }));
  await Promise.all(
    imgs
      .filter(i => typeof i.decode === 'function')
      .map(i => i.decode().catch(() => {}))
  );
  return imgs.length;
`

const RAF_HYBRID = `
  const raf = () => new Promise(r => {
    let done = false;
    const id = setTimeout(() => { if (!done) { done = true; r(null); } }, 250);
    requestAnimationFrame(() => { if (!done) { done = true; clearTimeout(id); r(null); } });
  });
`

const REFLOW_STABLE_JS = `
  ${RAF_HYBRID}
  const dims = () => [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
  let prev = dims();
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    await raf();
    await raf();
    const next = dims();
    if (next[0] === prev[0] && next[1] === prev[1]) return true;
    prev = next;
  }
  return false;
`

const ANIMATIONS_JS = `
  if (typeof document.getAnimations !== 'function') return 0;
  const running = document.getAnimations().filter(a => {
    if (a.playState !== 'running') return false;
    const t = a.effect && typeof a.effect.getTiming === 'function' ? a.effect.getTiming() : { iterations: 1 };
    return t.iterations !== Infinity;
  });
  await Promise.all(running.map(a => a.finished.catch(() => {})));
  return running.length;
`

const FINAL_COMMIT_JS = `
  ${RAF_HYBRID}
  await raf();
  await raf();
  return true;
`
