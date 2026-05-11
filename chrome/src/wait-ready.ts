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
  reached: string[]
  skipped: string[]
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

export async function waitOnSession(s: CdpSession, opts: WaitReadyOptions = {}): Promise<WaitReadyResult> {
  const o = { ...DEFAULTS, ...opts }
  const t0 = Date.now()
  const reached: string[] = []
  const skipped: string[] = []
  const steps: WaitReadyStep[] = []
  const elapsed = () => Date.now() - t0
  const remaining = () => Math.max(0, o.maxMs - elapsed())

  // Chrome throttles rAF/setTimeout/document.fonts.ready in non-focused tabs (down
  // to ~1 Hz). Emulation.setFocusEmulationEnabled makes the renderer believe the
  // page has focus — disables all throttling for our wait loop. Does NOT change
  // OS-level focus (Chrome stays wherever it was in the window stack).
  await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})

  const runStep = async (name: string, enabled: boolean, fn: () => Promise<void>) => {
    if (!enabled) { skipped.push(name); return }
    if (remaining() <= 0) { skipped.push(name); return }
    const budget = Math.max(50, Math.min(o.stepMs, remaining()))
    const sT = Date.now()
    try {
      await safeTimeout(fn(), budget, `${name} timeout after ${budget}ms`)
      steps.push({ name, ok: true, durationMs: Date.now() - sT })
      reached.push(name)
    } catch (e) {
      steps.push({ name, ok: false, durationMs: Date.now() - sT, error: e instanceof Error ? e.message : String(e) })
    }
  }

  await runStep("readyState", o.readyState, async () => {
    await pageEval(s, READY_STATE_JS)
  })

  await runStep("fonts", o.fonts, async () => {
    await pageEval(s, FONTS_JS)
  })

  await runStep("networkIdle", o.networkIdle, async () => {
    await networkIdle(s, o.idleMs, remaining())
  })

  await runStep("images", o.images, async () => {
    await pageEval(s, IMAGES_JS)
  })

  await runStep("reflowStable", o.reflowStable, async () => {
    await pageEval(s, REFLOW_STABLE_JS)
  })

  await runStep("animations", o.animations, async () => {
    await pageEval(s, ANIMATIONS_JS)
  })

  await runStep("finalCommit", o.finalCommit, async () => {
    await pageEval(s, FINAL_COMMIT_JS)
  })

  const timedOut = remaining() <= 0 && (reached.length + skipped.length) < 7
  return {
    ok: !timedOut && steps.every((x) => x.ok),
    reached,
    skipped,
    timedOut,
    durationMs: elapsed(),
    steps,
  }
}

async function pageEval(s: CdpSession, body: string): Promise<unknown> {
  const expression = `(async () => { ${body} })()`
  const res = await s.send<{
    result: { value?: unknown }
    exceptionDetails?: { exception?: { description?: string }; text?: string }
  }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS exception"
    throw new Error(msg)
  }
  return res.result.value
}

async function networkIdle(s: CdpSession, idleMs: number, maxMs: number): Promise<void> {
  await s.send("Network.enable")
  const ws = (s as unknown as { ws: WebSocket }).ws
  let inflight = 0
  let lastChange = Date.now()

  const onMsg = (ev: MessageEvent) => {
    try {
      const m = JSON.parse(ev.data as string) as { method?: string }
      switch (m.method) {
        case "Network.requestWillBeSent":
          inflight++
          lastChange = Date.now()
          break
        case "Network.loadingFinished":
        case "Network.loadingFailed":
          inflight = Math.max(0, inflight - 1)
          lastChange = Date.now()
          break
      }
    } catch {}
  }
  ws.addEventListener("message", onMsg)
  const deadline = Date.now() + maxMs
  try {
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastChange >= idleMs) return
      await new Promise((r) => setTimeout(r, 50))
    }
  } finally {
    ws.removeEventListener("message", onMsg)
  }
}

async function safeTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
