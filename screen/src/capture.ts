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

export type CaptureOptions = {
  display?: number;
  shadow?: boolean;
};

export async function captureDesktop(options: CaptureOptions = {}): Promise<Uint8Array> {
  const args: string[] = [];
  if (options.display !== undefined) args.push("-D", String(options.display));
  return await captureToBuffer(args);
}

export async function captureRect(rect: Rect, options: CaptureOptions = {}): Promise<Uint8Array> {
  const args: string[] = [];
  if (options.shadow === false) args.push("-o");
  args.push("-R", `${rect.x},${rect.y},${rect.width},${rect.height}`);
  return await captureToBuffer(args);
}

async function captureToBuffer(args: string[]): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "meta-screen-"));
  const outputPath = join(dir, "capture.png");
  try {
    await run(["/usr/sbin/screencapture", "-x", "-t", "png", ...args, outputPath]);
    const data = await readFile(outputPath);
    return new Uint8Array(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
