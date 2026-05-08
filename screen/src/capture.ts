import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DetailLevel = "low" | "medium" | "high" | "full";

const DETAIL_SCALE: Record<DetailLevel, number> = {
  low:    0.25,
  medium: 0.5,
  high:   0.75,
  full:   1.0,
};

export function parseDetail(value: string | null | undefined, fallback: number = 1.0): number {
  if (value == null) return fallback;
  if (value in DETAIL_SCALE) return DETAIL_SCALE[value as DetailLevel]!;
  const n = parseFloat(value);
  if (!isNaN(n) && n > 0 && n <= 1) return n;
  return fallback;
}

export type CaptureOptions = {
  display?: number;
  shadow?: boolean;
  scale?: number;
};

export async function captureDesktop(options: CaptureOptions = {}): Promise<Uint8Array> {
  const args: string[] = [];
  if (options.display !== undefined) args.push("-D", String(options.display));
  return await captureToBuffer(args, options.scale);
}

export async function captureRect(rect: Rect, options: CaptureOptions = {}): Promise<Uint8Array> {
  const args: string[] = [];
  if (options.shadow === false) args.push("-o");
  args.push("-R", `${rect.x},${rect.y},${rect.width},${rect.height}`);
  return await captureToBuffer(args, options.scale);
}

async function captureToBuffer(args: string[], scale?: number): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "meta-screen-"));
  const outputPath = join(dir, "capture.png");
  try {
    await run(["/usr/sbin/screencapture", "-x", "-t", "png", ...args, outputPath]);
    if (scale !== undefined && scale < 1 && scale > 0) {
      await scaleImage(outputPath, scale);
    }
    const data = await readFile(outputPath);
    return new Uint8Array(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scaleImage(path: string, scale: number): Promise<void> {
  const proc = spawn(["sips", "-g", "pixelWidth", path], { stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return;
  const match = out.match(/pixelWidth:\s+(\d+)/);
  if (!match) return;
  const targetWidth = Math.max(1, Math.round(parseInt(match[1]!) * scale));
  await run(["sips", "--resampleWidth", String(targetWidth), "--out", path, path]);
}

export async function writePng(path: string, data: Uint8Array): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent.length > 0) await mkdir(parent, { recursive: true });
  await Bun.write(path, data);
}

async function run(command: string[]): Promise<void> {
  const proc = spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command[0]} failed (${code}): ${err.trim() || out.trim()}`);
  }
}
