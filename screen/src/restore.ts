import { spawn } from "bun";

export async function frontmostApp(): Promise<string | null> {
  try {
    const out = await osa(`tell application "System Events" to get name of first application process whose frontmost is true`);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function osa(script: string): Promise<string> {
  const proc = spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`osascript failed (${code}): ${err.trim() || out.trim()}`);
  }
  return out.trim();
}
