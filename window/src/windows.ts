import { osa, quote } from "@meta/shared";

export type WindowInfo = {
  app: string;
  pid: number;
  title: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FrontmostAppInfo = {
  app: string;
  pid: number;
};

const SEP_FIELD = String.fromCharCode(31);
const SEP_RECORD = String.fromCharCode(30);

const LIST_WINDOWS = `
set fs to (ASCII character 31)
set rs to (ASCII character 30)
set out to ""
tell application "System Events"
  set procList to (every process whose background only is false)
  repeat with p in procList
    try
      set pName to name of p as string
      set pPid to unix id of p
      set winList to windows of p
      set wIdx to 0
      repeat with w in winList
        set wIdx to wIdx + 1
        try
          set wTitle to name of w as string
        on error
          set wTitle to ""
        end try
        try
          set {wx, wy} to position of w
        on error
          set wx to 0
          set wy to 0
        end try
        try
          set {ww, wh} to size of w
        on error
          set ww to 0
          set wh to 0
        end try
        set out to out & pName & fs & pPid & fs & wIdx & fs & wTitle & fs & wx & fs & wy & fs & ww & fs & wh & rs
      end repeat
    end try
  end repeat
end tell
return out
`;

export async function listWindows(): Promise<WindowInfo[]> {
  const raw = await osa(LIST_WINDOWS);
  if (!raw) return [];
  const windows = raw
    .split(SEP_RECORD)
    .filter((r) => r.length > 0)
    .map((rec) => {
      const [app, pid, index, title, x, y, w, h] = rec.split(SEP_FIELD);
      return {
        app: app ?? "",
        pid: Number(pid ?? 0),
        index: Number(index ?? 0),
        title: title ?? "",
        x: Number(x ?? 0),
        y: Number(y ?? 0),
        width: Number(w ?? 0),
        height: Number(h ?? 0),
      };
    });
  return uniqueWindows(windows);
}

function uniqueWindows(windows: WindowInfo[]): WindowInfo[] {
  const seen = new Set<string>();
  const out: WindowInfo[] = [];
  for (const win of windows) {
    const key = [
      win.app,
      win.pid,
      win.index,
      win.title,
      win.x,
      win.y,
      win.width,
      win.height,
    ].join(SEP_FIELD);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(win);
  }
  return out;
}

export async function focusApp(app: string): Promise<void> {
  await osa(`tell application ${quote(app)} to activate`);
}

export async function getFrontmostApp(): Promise<FrontmostAppInfo> {
  const raw = await osa(`
set fs to (ASCII character 31)
tell application "System Events"
  set p to first application process whose frontmost is true
  return (name of p as string) & fs & (unix id of p as string)
end tell
`);
  const [app = "", pid = "0"] = raw.split(SEP_FIELD);
  return { app, pid: Number(pid) };
}

export async function getFocusedWindow(): Promise<WindowInfo | null> {
  try {
    const raw = await osa(`
set fs to (ASCII character 31)
tell application "System Events"
  set p to first application process whose frontmost is true
  set pName to name of p as string
  set pPid to unix id of p
  set fw to value of attribute "AXFocusedWindow" of p
  set fwTitle to name of fw as string
  set fwPosition to position of fw
  set fwSize to size of fw
  set wIdx to 0
  set currentIdx to 0
  repeat with candidate in windows of p
    set currentIdx to currentIdx + 1
    try
      if (name of candidate as string) is fwTitle and (position of candidate) is fwPosition and (size of candidate) is fwSize then
        set wIdx to currentIdx
        exit repeat
      end if
    end try
  end repeat
  set {wx, wy} to fwPosition
  set {ww, wh} to fwSize
  return pName & fs & pPid & fs & wIdx & fs & fwTitle & fs & wx & fs & wy & fs & ww & fs & wh
end tell
`);
    const [app = "", pid = "0", index = "0", title = "", x = "0", y = "0", width = "0", height = "0"] = raw.split(SEP_FIELD);
    const window = {
      app,
      pid: Number(pid),
      index: Number(index),
      title,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    };
    return window.index > 0 ? window : null;
  } catch {
    return null;
  }
}

export async function raiseWindow(app: string, index: number): Promise<void> {
  await osa(
    `tell application "System Events" to tell process ${quote(app)} to perform action "AXRaise" of window ${index}`,
  );
}

export async function moveWindow(app: string, index: number, x: number, y: number): Promise<void> {
  await osa(
    `tell application "System Events" to tell process ${quote(app)} to set position of window ${index} to {${x}, ${y}}`,
  );
}

export async function resizeWindow(app: string, index: number, width: number, height: number): Promise<void> {
  await osa(
    `tell application "System Events" to tell process ${quote(app)} to set size of window ${index} to {${width}, ${height}}`,
  );
}

export async function getScreen(): Promise<{ width: number; height: number }> {
  const raw = await osa(
    `tell application "Finder" to get bounds of window of desktop`,
  );
  const parts = raw.split(",").map((s) => Number(s.trim()));
  return { width: parts[2] ?? 0, height: parts[3] ?? 0 };
}

export async function checkAccessibility(): Promise<{ granted: boolean; error?: string }> {
  try {
    await osa(`tell application "System Events" to get count of windows of first process whose frontmost is true`);
    return { granted: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { granted: false, error: msg };
  }
}
