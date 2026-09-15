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

export const MAX_CAPTURE_DIMENSION = 32_768
export const MAX_CAPTURE_PIXELS = 32_000_000
export const MAX_CAPTURE_ENCODED_BYTES = 64 * 1024 * 1024

export type EncodedImageMetadata = {
  widthPx: number
  heightPx: number
  encodedBytes: number
}

export type LegacyCaptureMetadata = EncodedImageMetadata & {
  caption?: string
}

export function parseDetail(value: unknown, fallback: number = 1.0): number {
  if (value == null || value === "") return fallback
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized in DETAIL_SCALE) return DETAIL_SCALE[normalized as DetailLevel]!
    value = Number(normalized)
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) {
    return value
  }
  return fallback
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function inspectPng(data: Uint8Array): EncodedImageMetadata {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  const ihdr = [73, 72, 68, 82]
  if (data.byteLength < 24
      || signature.some((byte, index) => data[index] !== byte)
      || ihdr.some((byte, index) => data[index + 12] !== byte)) {
    throw new Error("Capture backend вернул некорректный PNG")
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const widthPx = view.getUint32(16)
  const heightPx = view.getUint32(20)
  assertCaptureBudget(widthPx, heightPx, data.byteLength)
  return { widthPx, heightPx, encodedBytes: data.byteLength }
}

export function legacyCaptureMetadata(
  data: Uint8Array,
  caption?: string,
): LegacyCaptureMetadata {
  return {
    ...inspectPng(data),
    ...(caption ? { caption } : {}),
  }
}

export function assertCaptureBudget(
  widthPx: number,
  heightPx: number,
  encodedBytes: number,
): void {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx)
      || widthPx <= 0 || heightPx <= 0
      || widthPx > MAX_CAPTURE_DIMENSION || heightPx > MAX_CAPTURE_DIMENSION) {
    throw new Error("Capture dimensions превышают допустимый предел")
  }
  if (widthPx > Math.floor(MAX_CAPTURE_PIXELS / heightPx)) {
    throw new Error("Capture frame превышает 32 мегапикселя")
  }
  if (!Number.isInteger(encodedBytes) || encodedBytes <= 0
      || encodedBytes > MAX_CAPTURE_ENCODED_BYTES) {
    throw new Error("Encoded capture превышает 64 МиБ")
  }
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
