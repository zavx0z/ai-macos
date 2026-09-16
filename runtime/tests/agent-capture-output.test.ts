import { expect, test } from "bun:test"
import { agentCaptureOutput } from "../src/agent-capture-output.ts"

test.each([
  [1920, 1200, 1, 960, 600],
  [3840, 2160, 1, 1280, 720],
  [1728, 1117, 2, 1114, 720],
  [1080, 1920, 2, 405, 720],
  [7680, 2160, 1, 1280, 360],
])("уменьшает %s×%s при scale %s, сохраняя весь кадр", (width, height, backing, expectedWidth, expectedHeight) => {
  const policy = agentCaptureOutput(width, height, backing)
  expect([Math.ceil(width * backing * policy.scale), Math.ceil(height * backing * policy.scale)])
    .toEqual([expectedWidth, expectedHeight])
})

test("отклоняет неизвестную геометрию вместо полноразмерного fallback", () => {
  expect(() => agentCaptureOutput(0, 1200, 1)).toThrow("подтверждённые размеры")
})
