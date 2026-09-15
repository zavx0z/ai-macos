import { describe, expect, test } from "bun:test"
import {
  canonicalRecoveryJson,
  nativeRecoveryDescriptorSchema,
  type NativeRecoveryDescriptor,
} from "@meta/shared/contracts"
import {
  nativeClipboardRequestSchema,
} from "../src/clipboard-protocol.ts"
import {
  nativeInputExecutionRequestSchema,
  type NativeInputExecutionPayload,
} from "../src/protocol.ts"
import {
  classifyNativeRecoveryDescriptor,
  type ParsedNativeMutationRequest,
} from "../src/recovery-domain-classifier.ts"

const generation = {
  runtimeEpoch: "runtime:recovery-domain",
  loginSessionId: "login:recovery-domain",
  nativeGeneration: "native:recovery-domain",
}

function inputRequest(action: NativeInputExecutionPayload["action"]) {
  const deadlineAt = "2030-09-15T10:00:00.000Z"
  return nativeInputExecutionRequestSchema.parse({
    kind: "request",
    intent: "mutation",
    protocolVersion: "1",
    requestId: `request:${action.kind}`,
    ...generation,
    deadlineAt,
    method: "input.execute",
    operation: {
      kind: "native",
      operationId: `operation:${action.kind}`,
      clientRequestId: `client-request:${action.kind}`,
      clientSessionId: "client:recovery-domain",
      principalId: "principal:recovery-domain",
      ...generation,
      deadlineAt,
      inventoryId: "inventory:recovery-domain",
      inventoryRevision: 1,
      observationRef: {
        observationId: "observation:recovery-domain",
        inventoryRevision: 1,
        displayLayoutRevision: 1,
        proofRef: "proof:recovery-domain",
      },
      fence: { ...generation, counter: 1 },
      target: {
        kind: "window",
        ref: {
          ...generation,
          applicationRef: "application:recovery-domain",
          windowRef: "window:recovery-domain",
        },
      },
    },
    payload: { actionDeadlineAt: deadlineAt, action },
  })
}

function classify(action: NativeInputExecutionPayload["action"]) {
  return classifyNativeRecoveryDescriptor(
    inputRequest(action),
    "native-build:recovery-domain",
  )
}

describe("Native recovery-domain classifier", () => {
  test("Unicode text хранит только possible key 0 без plaintext", () => {
    const secret = "секретный текст"
    const descriptor = classify({
      kind: "text",
      utf16Units: secret.length,
      clusters: [{ text: secret, utf16Units: secret.length, atMs: 0 }],
    })

    expect(descriptor).toEqual({
      policyVersion: "1",
      nativeBuildId: "native-build:recovery-domain",
      method: "input.execute",
      domain: "possible-held-input",
      possibleHolds: [{ kind: "key", code: 0 }],
    })
    expect(canonicalRecoveryJson(descriptor)).not.toContain("секретный")
  })

  test("key и shortcut сохраняют реальные codes, но не modifier flags", () => {
    expect(classify({
      kind: "key",
      stroke: { keyCode: 12, flags: 0x001a0000 },
    }).possibleHolds).toEqual([{ kind: "key", code: 12 }])
    expect(classify({
      kind: "shortcut",
      strokes: [
        { keyCode: 42, flags: 0x00100000 },
        { keyCode: 7, flags: 0x00020000 },
        { keyCode: 42, flags: 0x00100000 },
      ],
      delayMs: 10,
    }).possibleHolds).toEqual([
      { kind: "key", code: 7 },
      { kind: "key", code: 42 },
    ])
  })

  test("click и drag сохраняют только выбранную button", () => {
    expect(classify({
      kind: "click",
      button: "right",
      point: { x: 10, y: 20 },
      count: 2,
      modifiers: { names: ["cmd"], flags: 0x00100000 },
    }).possibleHolds).toEqual([{ kind: "button", code: 1 }])
    expect(classify({
      kind: "drag",
      button: "middle",
      modifiers: { names: ["shift"], flags: 0x00020000 },
      durationMs: 20,
      trajectory: [
        { point: { x: 10, y: 20 }, atMs: 0 },
        { point: { x: 30, y: 40 }, atMs: 20 },
      ],
    }).possibleHolds).toEqual([{ kind: "button", code: 2 }])
  })

  test("hover, scroll, readiness и AXPress не объявляют held input", () => {
    const actions: NativeInputExecutionPayload["action"][] = [
      {
        kind: "hover",
        point: { x: 10, y: 20 },
        modifiers: { names: [], flags: 0 },
      },
      {
        kind: "scroll",
        anchor: { x: 10, y: 20 },
        dx: 0,
        dy: 1,
        unit: "line",
        modifiers: { names: [], flags: 0 },
      },
    ]
    for (const action of actions) {
      expect(classify(action)).toMatchObject({
        domain: "no-held-input",
        possibleHolds: [],
      })
    }
    for (const method of [
      "application.launch",
      "application.quit",
      "ax.press",
      "capture.cancel",
      "capture.release",
      "capture.start",
      "input.readiness",
      "window.transition",
    ] as const) {
      const request = {
        intent: "mutation",
        method,
        payload: {},
      } as unknown as ParsedNativeMutationRequest
      expect(classifyNativeRecoveryDescriptor(
        request,
        "native-build:recovery-domain",
      )).toMatchObject({ method, domain: "no-held-input", possibleHolds: [] })
    }
  })

  test("не выдаёт no-held default неизвестному method или primitive", () => {
    const unknownMethod = {
      intent: "mutation",
      method: "input.future",
      payload: {},
    } as unknown as ParsedNativeMutationRequest
    const unknownPrimitive = {
      intent: "mutation",
      method: "input.execute",
      payload: { action: { kind: "future" } },
    } as unknown as ParsedNativeMutationRequest

    expect(() => classifyNativeRecoveryDescriptor(
      unknownMethod,
      "native-build:recovery-domain",
    )).toThrow("Unknown Native recovery method")
    expect(() => classifyNativeRecoveryDescriptor(
      unknownPrimitive,
      "native-build:recovery-domain",
    )).toThrow("Unknown input.execute recovery primitive")
  })

  test("clipboard.write получает no-held descriptor без текста, read/version отклоняются", () => {
    const deadlineAt = "2030-09-15T10:00:00.000Z"
    const operation = {
      kind: "clipboard" as const,
      operationId: "operation:clipboard-recovery",
      clientRequestId: "client-request:clipboard-recovery",
      clientSessionId: "client:clipboard-recovery",
      principalId: "principal:clipboard-recovery",
      runtimeEpoch: generation.runtimeEpoch,
      loginSessionId: generation.loginSessionId,
      deadlineAt,
      inventoryId: "inventory:clipboard-recovery",
      inventoryRevision: 1,
      target: {
        kind: "clipboard" as const,
        ref: {
          runtimeEpoch: generation.runtimeEpoch,
          loginSessionId: generation.loginSessionId,
          clipboardRef: "system" as const,
        },
      },
    }
    const envelope = {
      kind: "request" as const,
      protocolVersion: "1" as const,
      requestId: "request:clipboard-recovery",
      ...generation,
      deadlineAt,
      operation,
    }
    const write = nativeClipboardRequestSchema.parse({
      ...envelope,
      command: {
        method: "clipboard.write",
        payload: { text: "секрет из clipboard", expectedChangeCount: 7 },
      },
    })
    const descriptor = classifyNativeRecoveryDescriptor(
      write,
      "native-build:recovery-domain",
    )
    expect(descriptor).toMatchObject({
      method: "clipboard.write",
      domain: "no-held-input",
      possibleHolds: [],
    })
    expect(canonicalRecoveryJson(descriptor)).not.toContain("секрет")

    for (const command of [
      { method: "clipboard.read" as const, payload: { maxBytes: 1024 } },
      { method: "clipboard.version" as const, payload: {} },
    ]) {
      const request = nativeClipboardRequestSchema.parse({
        ...envelope,
        requestId: `request:${command.method}`,
        command,
      })
      expect(() => classifyNativeRecoveryDescriptor(
        request,
        "native-build:recovery-domain",
      )).toThrow("Clipboard recovery не авторизует")
    }
  })

  test("canonical descriptor не допускает duplicate или unsorted holds", () => {
    const raw = {
      policyVersion: "1",
      nativeBuildId: "native-build:recovery-domain",
      method: "input.execute",
      domain: "possible-held-input",
      possibleHolds: [
        { kind: "key", code: 2 },
        { kind: "key", code: 1 },
      ],
    } satisfies NativeRecoveryDescriptor
    expect(nativeRecoveryDescriptorSchema.safeParse(raw).success).toBe(false)
    expect(nativeRecoveryDescriptorSchema.safeParse({
      ...raw,
      possibleHolds: [
        { kind: "key", code: 1 },
        { kind: "key", code: 1 },
      ],
    }).success).toBe(false)
    expect(classify({
      kind: "shortcut",
      strokes: [
        { keyCode: 2, flags: 0 },
        { keyCode: 1, flags: 0 },
      ],
      delayMs: 0,
    }).possibleHolds).toEqual([
      { kind: "key", code: 1 },
      { kind: "key", code: 2 },
    ])
  })
})
