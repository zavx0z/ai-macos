import type { CaptureOutputPolicy } from "@meta/shared/contracts"

/** Уменьшенный снимок для агента: весь target помещается в 1280×720 без обрезки. */
export function agentCaptureOutput(width: number, height: number, backingScale: number): CaptureOutputPolicy {
  if (![width, height, backingScale].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Capture preview требует подтверждённые размеры и scale")
  }
  return {
    format: "image/png",
    scale: Math.min(0.5, 1280 / (width * backingScale), 720 / (height * backingScale)),
    maxWidthPx: 1280,
    maxHeightPx: 720,
    maxPixels: 1280 * 720,
    maxEncodedBytes: 2 * 1024 * 1024,
  }
}
