import { selectUniqueWindow } from "@meta/shared"
import { raiseWindow, listWindows } from "./windows.ts";

type Pin = {
  id: string;
  app: string;
  index: number;
  pid: number;
  windowId?: number;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
  raises: number;
  errors: number;
};

const pins = new Map<string, Pin>();
let nextId = 1;

export type PinPublic = Omit<Pin, "timer">;

export async function startPin(app: string, index = 1, intervalMs = 500, pid?: number, windowId?: number): Promise<PinPublic> {
  const target = selectUniqueWindow(await listWindows(), { app, index, pid, windowId })
  if (!target) throw new Error("visible pin target not found")
  const id = String(nextId++);
  const pin: Pin = {
    id,
    app,
    index: target.index,
    pid: target.pid,
    windowId: target.windowId,
    intervalMs,
    timer: setInterval(async () => {
      try {
        await raiseWindow(pin.app, pin.index, pin.pid, pin.windowId);
        pin.raises++;
      } catch {
        pin.errors++;
      }
    }, intervalMs),
    startedAt: Date.now(),
    raises: 0,
    errors: 0,
  };
  pins.set(id, pin);
  return toPublic(pin);
}

export function stopPin(id: string): boolean {
  const p = pins.get(id);
  if (!p) return false;
  clearInterval(p.timer);
  pins.delete(id);
  return true;
}

export function stopAllPins(): number {
  const n = pins.size;
  for (const p of pins.values()) clearInterval(p.timer);
  pins.clear();
  return n;
}

export function listPins(): PinPublic[] {
  return Array.from(pins.values()).map(toPublic);
}

function toPublic(p: Pin): PinPublic {
  const { timer: _t, ...rest } = p;
  void _t;
  return rest;
}
