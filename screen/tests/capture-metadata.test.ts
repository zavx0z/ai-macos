import { describe, expect, test } from "bun:test"
import {
  MAX_CAPTURE_ENCODED_BYTES,
  MAX_CAPTURE_PIXELS,
  assertCaptureBudget,
  finiteNumber,
  inspectPng,
  legacyCaptureMetadata,
  parseDetail,
} from "../src/capture.ts"

describe("capture scale", () => {
  test("accepts named detail and fractional numeric scale", () => {
    expect([
      parseDetail("medium"),
      parseDetail("0.5"),
      parseDetail(0.5),
    ]).toEqual([0.5, 0.5, 0.5])
  })

  test("rejects partial numeric strings and out-of-range values", () => {
    expect([
      parseDetail("0.5oops"),
      parseDetail(0),
      parseDetail(1.1),
    ]).toEqual([1, 1, 1])
  })

  test("keeps negative logical origins", () => {
    expect(finiteNumber("-1280")).toBe(-1280)
  })
})

describe("encoded frame metadata", () => {
  test("reads dimensions from a Uint8Array view without leaking the backing buffer", () => {
    const backing = new Uint8Array(64)
    const png = backing.subarray(7, 31)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    png.set([73, 72, 68, 82], 12)
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    view.setUint32(16, 640)
    view.setUint32(20, 480)
    expect(inspectPng(png)).toEqual({ widthPx: 640, heightPx: 480, encodedBytes: 24 })
  })

  test("round-trips caption in legacy frame metadata", () => {
    const png = new Uint8Array(24)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    png.set([73, 72, 68, 82], 12)
    const view = new DataView(png.buffer)
    view.setUint32(16, 1)
    view.setUint32(20, 1)
    expect(legacyCaptureMetadata(png, "Ожидаю увидеть выбранный дисплей")).toEqual({
      widthPx: 1,
      heightPx: 1,
      encodedBytes: 24,
      caption: "Ожидаю увидеть выбранный дисплей",
    })
  })

  test("enforces pixel and encoded-byte budgets", () => {
    expect(() => assertCaptureBudget(8000, 4000, MAX_CAPTURE_ENCODED_BYTES)).not.toThrow()
    expect(() => assertCaptureBudget(8001, 4000, 1)).toThrow("32 мегапикселя")
    expect(() => assertCaptureBudget(1, 1, MAX_CAPTURE_ENCODED_BYTES + 1)).toThrow("64 МиБ")
    expect(MAX_CAPTURE_PIXELS).toBe(32_000_000)
  })
})
