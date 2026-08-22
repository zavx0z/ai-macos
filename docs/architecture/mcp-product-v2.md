# ai-macos MCP product v2

Status: first vertical implemented on `codex/mcp-product-v2`.

This document is normative for the v2 public MCP contract and descriptive for later slices. It is grounded in the repository at `ec5e2e66d4de12dff0e7c1509d4f38f7b90a5063`.

## 1. Product failure and current-system critique

The reported failure was not primarily a prompting failure. `mcp/src/index.ts` advertised `keyboard_shortcut({shortcut})`, while `input/src/index.ts` accepted `/keyboard/shortcut` without any target. A successful CoreGraphics event delivery therefore became `{ok:true}` even if Safari was absent. Natural-language instructions to call `list_windows`, focus, act, and capture were neither atomic nor enforced.

The same trust gap appears throughout the current tree:

- `window/src/windows.ts` exposes mutable per-process `index`; `window/src/index.ts` accepts it for focus-adjacent mutations without a lease or generation.
- Legacy `/focus` activates an application, not an exact window, and returns `{ok:true}` without re-observing focus.
- `screen/src/index.ts` selects by index or title substring and restores only the prior app name. It cannot prove that the prior exact window was restored.
- `screen/src/index.ts` captures geometry observed before `raise`; a window can move or be replaced between selection and capture.
- `input/src/index.ts` correctly checks Accessibility and native event delivery, but its `ok:true` means delivery only. It has no knowledge of UI effect.
- `chrome/src/index.ts` still permits optional `windowId`/`tabIndex` for several operations even though repository instructions require both. AppleScript fallback can address the wrong Chrome instance.
- `android/src/index.ts` has a stable CDP `tabId`, but no server epoch/lease or device binding is carried with it.
- `mcp/src/screenshot-ui.ts` is a useful MCP Apps component, but legacy action tools do not automatically produce evidence through it.
- `system_health` previously covered only window/screen/input and treated liveness as readiness. Chrome, Android, permissions, dependency generations, and degraded states were incomplete.
- Errors are mostly `{error,hint}` strings. They do not provide stable codes, recovery actions, candidates, or correlation IDs.
- No cross-service lock binds target resolution, focus, input, verification, capture, and restoration. Concurrent agents can interleave the sequence.
- The root has no unified build/typecheck/test script; several package tsconfigs refer to a non-existent `../../tsconfig.base.json`.

The architectural rule is therefore: safety and truthfulness must be properties of one server transaction, not behavior requested from a language model.

## 2. Agent-facing intent model

### 2.1 Public MCP taxonomy

The target public surface is intentionally small:

| Tool | Intent | Semantics |
|---|---|---|
| `system_health` | readiness | Read-only readiness/degraded report for all adapters. |
| `observe_targets` | observation and selection | Read-only target summaries, opaque handles, snapshots, capabilities. |
| `desktop_action` | exact macOS window input | Transactional shortcut/key/type/click/scroll with proof and exact restoration. First slice implements shortcut. |
| `desktop_arrange` | exact window layout | Transactional arrange plus geometry verification and screenshot. |
| `capture` | desktop/window/display proof | Read-only exact target capture using handle/snapshot. |
| `browser_action` | desktop Chrome tab | Navigate/reload/back/forward against an exact window + CDP target lease. |
| `android_action` | Android Chrome tab | Navigate/reload against an exact device + CDP target lease. |
| `clipboard_read` | clipboard read | Explicit read with sensitivity warning and audit. |
| `clipboard_write` | clipboard write | Direct pbcopy transaction with byte-count verification. |

Only `system_health`, `desktop_action`, `capture_desktop`, `clipboard_read`, and `clipboard_write` are published in the first slice. Later tools must reuse the same target directory and result envelope; they must not reintroduce REST wrappers.

### 2.2 Intent that must be one tool call

From the agent's point of view, each of these is one call:

- “Reload the exact running Safari window and show proof”: `desktop_action(app:"Safari", shortcut:"cmd+r")`. Zero matches fails without launching; multiple matches returns handles; a selected handle finishes focus, dispatch, verification, screenshot, and restoration.
- “Click/type/shortcut/scroll in this exact window”: one `desktop_action` call. A click uses target-local coordinates bound to a fresh snapshot ID.
- “Navigate/reload this exact Chrome tab”: one `browser_action` call bound to desktop Chrome window identity and CDP target ID.
- “Navigate/reload this exact Android tab”: one `android_action` call bound to device serial, transport generation, and CDP target ID.
- “Arrange this window and show it”: one `desktop_arrange` call with post-geometry verification and evidence.
- “Capture this window/display”: one `capture` call.
- “Read/write clipboard”: one specialized clipboard call; UI emulation is never used.

### 2.3 When clarification is required

The server returns `needs_target` rather than guessing when:

- an app selector matches more than one visible window;
- a Chrome selector matches multiple windows or tabs;
- more than one Android device or tab matches;
- a target-local coordinate lacks the snapshot on which it was selected;
- a destructive action's scope cannot be derived from an exact target;
- the requested effect cannot be mapped to a supported verifier and the user explicitly requires proof.

No clarification is required when an app selector has exactly one visible window or the caller supplies a fresh opaque handle.

### 2.4 Operations that must not be advertised to the model

These remain internal adapter APIs or development-only endpoints:

- raw global mouse move/click/drag/scroll;
- raw key, text, or shortcut dispatch;
- focus-by-app and raise-by-index;
- screenshot-by-title-substring or mutable index;
- arbitrary AppleScript, JavaScript, CDP method, ADB command, or shell execution;
- Chrome “active tab/front window” defaults;
- permission prompts as an incidental side effect of an action.

The loopback REST APIs may retain these temporarily for local compatibility, but the MCP process does not publish them. An environment variable must not silently enable them in the default production config.

## 3. Unified target model

### 3.1 Identity versus observation

Immutable identity and mutable observation are different data:

```ts
type TargetIdentity =
  | { kind: "mac_window"; epoch: string; pid: number; cgWindowId: number }
  | { kind: "display"; epoch: string; displayId: number }
  | { kind: "chrome_tab"; epoch: string; pid: number; cgWindowId: number; cdpTargetId: string }
  | { kind: "android_tab"; epoch: string; deviceSerial: string; transportGeneration: number; cdpTargetId: string }

type TargetObservation = {
  identity: TargetIdentity
  observedAt: string
  title?: string
  url?: string
  bounds?: { x: number; y: number; width: number; height: number }
  focused?: boolean
  visible?: boolean
}
```

Titles, URLs, geometry, tab indices, and z-order are observations, never identity. `window/native/meta_window_helper.c` now lists on-screen layer-zero windows with `CGWindowID` and pid. Exact focus uses AX and verifies the requested CG identity; when AX does not expose a window number, geometry is used only to correlate one unambiguous AX window to a CG identity. Ambiguous correlation fails closed.

### 3.2 Opaque handles and leases

Public handles are random, non-derivable `win_<uuid>` values. `mcp/src/v2/lease-store.ts` stores the identity server-side with:

- service epoch;
- expiry (30 seconds in the first slice);
- target kind and immutable identity;
- minimal display metadata.

A handle is rejected if absent, expired, from another epoch, or no longer present. Process restart changes epoch. Handle data is not trusted from the model.

Future multi-process deployments move the lease store to a single local broker; individual MCP connections use session IDs and capability scopes.

### 3.3 Snapshots and target-local coordinates

Future click input is:

```json
{
  "targetHandle": "win_opaque",
  "action": {
    "kind": "click",
    "snapshotId": "snap_opaque",
    "point": { "x": 412, "y": 238 }
  }
}
```

`point` is relative to the content represented by `snapshotId`, not global screen coordinates. Immediately before dispatch the server validates snapshot epoch, target identity, TTL, scale/DPR, and current geometry. It then converts to global coordinates. Changed geometry can be safely recomputed only if the screenshot content coordinate system is unchanged; otherwise `stale_snapshot` is returned with zero input.

## 4. Transaction model

### 4.1 State machine

```text
queued
  -> lock_acquired
  -> observed
  -> resolved | needs_target | target_not_found
  -> previous_focus_saved
  -> exact_target_focused_and_verified
  -> lease_and_focus_revalidated
  -> dispatched
  -> effect_verified | effect_unconfirmed
  -> evidence_captured
  -> exact_previous_focus_restored_and_verified
  -> completed
```

Every exit after `previous_focus_saved` passes through restoration. `mcp/src/v2/action-transaction.ts` implements a process-wide exclusive mutex for desktop focus/input. A later broker provides fair multi-session locks, cancellation, and crash recovery.

### 4.2 TOCTOU closure

Immediately before calling the internal input adapter, the first slice concurrently checks:

1. the lease still exists and is unexpired;
2. the window service epoch is unchanged;
3. the same `pid + CGWindowID` is still visible;
4. the exact target is the currently focused window.

Any failure returns `rejected_stale_target` and sends zero input events.

### 4.3 Concurrency, deadlines, cancellation, idempotency

- Desktop focus/input is globally exclusive. Read-only observation can remain concurrent.
- Browser CDP transactions lock by target ID; Android locks by device serial + target ID.
- The first slice bounds calls to 1–30 seconds and records the effective deadline.
- Verification is separately bounded (two seconds for the Safari title-marker verifier) so capture/restoration retain deadline budget.
- `idempotencyKey` caches a completed result within the MCP process. Production v2 records keys in the broker with session scope and TTL.
- MCP cancellation must abort waits and verification, then run restoration. Input dispatch itself is not retried after uncertain delivery.

## 5. Result contract: delivery is not effect

The server never returns a bare success boolean. The relevant envelope is:

```json
{
  "status": "verified",
  "correlationId": "uuid",
  "target": { "handle": "win_opaque", "app": "Safari", "title": "fixture:41" },
  "delivery": { "status": "delivered" },
  "effect": {
    "status": "confirmed",
    "evidence": { "kind": "window_title_changed", "before": "fixture:41", "after": "fixture:42" }
  },
  "verification": { "status": "confirmed" },
  "restoration": { "status": "restored" },
  "artifact": {
    "kind": "screenshot", "mimeType": "image/png", "imageIncluded": true,
    "caption": "Post-action evidence for Safari window 123"
  },
  "audit": [],
  "timings": { "totalMs": 843, "boundedByMs": 12000 }
}
```

`status="verified"` is impossible unless `delivery.status="delivered"` and `effect.status="confirmed"`. Generic shortcuts without a supported verifier return `delivered_unverified`. Restoration failure changes the top-level status to `verified_restoration_failed` even if effect proof exists. PNG bytes are omitted from `structuredContent`, placed in MCP image content/private metadata, and rendered by `mcp/src/screenshot-ui.ts`.

Typed failure:

```json
{
  "status": "needs_target",
  "correlationId": "uuid",
  "delivery": { "status": "not_attempted" },
  "effect": { "status": "not_checked" },
  "verification": { "status": "not_run" },
  "restoration": { "status": "not_needed" },
  "error": {
    "code": "needs_target",
    "message": "Multiple visible windows match Safari",
    "nextAction": "Ask the user which candidate to use, then repeat with targetHandle",
    "candidates": [
      { "handle": "win_opaque", "app": "Safari", "title": "Docs", "bounds": { "x": 0, "y": 25, "width": 900, "height": 700 }, "expiresAt": "..." }
    ],
    "correlationId": "uuid"
  }
}
```

This contract physically prevents a conforming client from equating event delivery with verified effect: there is no `ok:true`, and verified status is a closed enum with required evidence fields.

## 6. Public input schema

The implemented schema is intentionally flat to avoid deeply nested unions and ChatGPT schema warnings:

```json
{
  "type": "object",
  "properties": {
    "app": { "type": "string", "minLength": 1 },
    "targetHandle": { "type": "string", "minLength": 1 },
    "shortcut": { "type": "string", "minLength": 1, "maxLength": 80 },
    "verifyTitlePrefix": { "type": "string", "minLength": 1, "maxLength": 200 },
    "deadlineMs": { "type": "integer", "minimum": 1000, "maximum": 30000 },
    "idempotencyKey": { "type": "string", "minLength": 1, "maxLength": 128 }
  },
  "required": ["shortcut"],
  "additionalProperties": false
}
```

Runtime validation requires exactly one of `app` and `targetHandle`; the first slice currently rejects missing target and gives `targetHandle` precedence if both are sent. A follow-up makes “both” an explicit `invalid_target` without introducing a JSON Schema union.

`verifyTitlePrefix` opts into deterministic title-transition verification. It is intended for a controlled fixture such as `ai-macos-reload-count:`; an unrelated title change is not accepted as reload proof. Without a supported verifier, delivery remains `delivered_unverified`. If dispatch throws after it begins, delivery is `unknown`, not falsely `not_attempted` or `failed`.

## 7. Internal REST v2 and adapter boundaries

Implemented window primitives:

- `GET /v2/windows?app=` → `{epoch,observedAt,windows:[{windowId,pid,app,title,bounds...}]}`
- `GET /v2/focus` → `{epoch,focused:{pid,windowId}|null}`
- `POST /v2/focus {pid,windowId}` → exact focus plus `{verified:true}` or typed HTTP failure

The MCP adapter in `mcp/src/v2/rest-adapter.ts` uses:

- window v2 for identity, focus, and freshness;
- input `/keyboard/shortcut` only as an internal delivery adapter;
- screen `/rect` only after a fresh exact identity and focus check.

Target internal API:

| Boundary | Responsibility |
|---|---|
| target broker | epochs, sessions, handles, leases, snapshots, locks, idempotency |
| macOS window adapter | CG/AX identity, visibility, focus/raise, geometry, permissions |
| input adapter | native delivery only; never decides target/effect |
| capture adapter | exact target pixels and artifact storage |
| Chrome adapter | Chrome window ↔ CG identity plus CDP target binding |
| Android adapter | device serial/transport generation/CDP target binding |
| verifier registry | action-specific effect evidence |
| audit store | immutable correlation timeline with redaction |

Future internal routes are under `/v2/transactions`, `/v2/targets`, and `/v2/artifacts`; public MCP tools must not expose them one-for-one.

## 8. Failure matrix

| Failure | Input events | Focus | Result |
|---|---:|---|---|
| app has zero visible windows | 0 | unchanged | `target_not_found` |
| app has multiple windows | 0 | unchanged | `needs_target` + handles |
| handle expired/epoch changed | 0 | unchanged | `rejected_stale_target` |
| target closes before focus | 0 | unchanged | `rejected_stale_target` |
| target changes/closes after focus, before dispatch | 0 | restore previous | `rejected_stale_target` |
| exact focus verification fails | 0 | restore previous | `action_failed` |
| input backend rejects | unknown delivery is never retried | restore previous | `action_failed` |
| event delivered, effect unprovable | 1 | restore previous | `delivered_unverified` |
| effect confirmed, screenshot fails | 1 | restore previous | verified effect; artifact/audit failure; follow-up will use a distinct `verified_without_artifact` state |
| previous exact window closed | 1 or 0 | cannot restore | `verified_restoration_failed` or `action_failed`, restoration=`previous_target_gone` |
| restoration focus verification fails | 1 or 0 | honest current state | restoration=`failed` |
| deadline/cancellation | never retry uncertain delivery | restoration attempted | typed deadline/cancel outcome |

## 9. Permissions, capabilities, and confirmations

Capabilities are checked before mutation:

- `observe_windows`: CoreGraphics list;
- `focus_exact`: Accessibility for `meta-window-helper`;
- `input`: Accessibility for `meta-input-helper`;
- `capture`: Screen Recording;
- `chrome_cdp`, `chrome_automation`, `android_adb`: adapter-specific.

Permission prompting is an explicit user-visible operation. An action does not repeatedly prompt or retry. `POST /permissions/accessibility` now requests the native window helper and opens the correct System Settings page, but public MCP permission workflows should be a dedicated confirmation tool/UI.

Risk classes:

- read: observation, capture, health;
- write-local: arrange, clipboard write, non-submitting text;
- consequential: click, Enter, shortcuts that close/send/delete, navigation to external systems;
- destructive/external: purchases, messages, account/security changes.

The tool declares conservative MCP annotations, and the transaction requires a scoped confirmation token for later consequential action kinds. A token binds session, target, action digest, expiry, and one-time nonce; raw input cannot bypass it.

## 10. Health, audit, and observability

`system_health` now queries window, screen, input, Chrome, and Android. The next slice standardizes:

```json
{
  "state": "ready|degraded|unavailable",
  "epoch": "uuid",
  "capabilities": { "focus_exact": true, "input": true, "capture": true },
  "dependencies": {},
  "permissions": {},
  "checkedAt": "RFC3339"
}
```

Every transaction has a correlation ID and bounded stage timings. Audit events include session ID, redacted selector, resolved identity hash, lease/snapshot IDs, delivery outcome, verifier outcome, artifact reference, and restoration outcome. Typed adapter errors keep `{code,message,nextAction,candidates?,correlationId}`. Clipboard text, typed text, screenshots, URLs with secrets, and key material are redacted or stored only in short-lived artifacts.

## 11. MCP Apps resources

Large PNG and complex results are not embedded into structured JSON. The tool result contains:

- compact `structuredContent` for model reasoning;
- an MCP `image` content block for clients;
- private `_meta.screenshot` for the existing `ui://widget/ai-macos-screenshot-v4.html` component;
- no base64 in structured content or textual logs.

Later resources:

- target picker for `needs_target` candidates;
- proof viewer with before/after and verification badges;
- transaction timeline for partial failure/restoration;
- permission readiness panel.

Components receive opaque resource/artifact references, never raw OS capabilities.

## 12. Browser and Android convergence

Chrome identity becomes `{pid,cgWindowId,cdpTargetId}`. `windowId + tabIndex` is migration-only; tab index is mutable. The adapter must resolve a CDP target ID, bind it to the correct Chrome process/window, revalidate before navigation/reload, and return CDP lifecycle evidence plus screenshot.

Android identity becomes `{deviceSerial,transportGeneration,cdpTargetId}`. ADB forwarding increments generation whenever recreated. A stale generation fails before CDP dispatch. Multiple devices or tabs return candidates.

Both use the same delivery/effect/restoration envelope. Browser actions that do not steal macOS focus report restoration=`not_needed`.

## 13. Versioning and compatibility

- MCP server version advances from `0.2.1` to `0.3.0` for the first vertical.
- New internal REST lives under `/v2` and carries service epoch.
- Legacy REST stays temporarily for existing CLI/tests but is documented as unsafe for model-facing input.
- Legacy MCP raw tools are removed from default advertisement in this slice. Clients migrate to `desktop_action`.
- During a time-boxed compatibility window, a separate development server profile may expose legacy tools with `legacy_` names and an explicit unsafe banner. It is not installed in ChatGPT/Codex configs.
- v2 breaking changes increment the MCP major tool name or server major version; fields are additive within a version.

Migration mapping:

| Legacy | v2 |
|---|---|
| `list_windows` + `focus_window` + `keyboard_shortcut` + `capture_window` | one `desktop_action` |
| `mouse_click` with global x/y | `desktop_action` click with target handle + snapshot ID |
| `keyboard_type` on current focus | `desktop_action` type on exact target |
| `arrange_window` by app/index | `desktop_arrange` by handle |
| Chrome optional active target | required Chrome target handle |
| Android `tabId` alone | device-bound Android target handle |

## 14. Test pyramid

Implemented:

- pure unit/contract tests in `mcp/tests/desktop-action.test.ts` for absent, ambiguous, exact selection, restoration, action exception, delivery/effect separation, stale epoch, target close, prior-target close, and screenshot artifact contract;
- MCP stdio surface/resource contract in `mcp/tests/stdio.test.ts`;
- runnable gated Safari acceptance harness in `mcp/tests/safari-reload.e2e.test.ts`.

Target pyramid:

1. Unit: lease TTL/epoch, resolver, locks, deadlines, coordinates, verifier truth tables.
2. Contract: JSON schemas, typed errors, MCP annotations/resources, adapter version negotiation.
3. Integration: fake REST services with faults injected at every stage.
4. Real macOS E2E: native helper identity/focus, no-input negative cases, permission degraded modes, multi-window exact selection.
5. Safari fixture E2E: dedicated local page increments a load counter in title; product action never opens Safari; one call proves reload and exact restoration.
6. Chrome/Android E2E: stable target leases across reorder, reload lifecycle proof, transport generation changes.
7. ChatGPT UI E2E: schemas load without warnings, picker handles ambiguity, PNG is large inline, model cannot call raw input.

The real Safari test is gated by `AI_MACOS_REAL_SAFARI_E2E=1`, `AI_MACOS_MCP_E2E_URL`, and an already-open deterministic fixture. This prevents tests from launching or mutating a user's Safari unexpectedly.

## 15. Target package structure

```text
packages/
  contracts/        # schemas, errors, result envelope
  target-broker/    # sessions, leases, locks, snapshots, idempotency
  transaction-core/ # state machines and verifier registry
  adapter-macos/    # CG/AX helper and window/display operations
  adapter-input/    # private native delivery
  adapter-capture/  # screenshots/artifacts
  adapter-chrome/   # Chrome/CDP binding
  adapter-android/  # ADB/CDP binding
  mcp-server/       # small intent tools only
  mcp-apps/         # picker, proof, health UI
```

The current monorepo packages migrate incrementally; this first slice keeps code in `window/` and `mcp/src/v2/` to avoid a flag-day rewrite.

## 16. Small-commit migration plan

1. Architecture and normative contracts; no runtime change.
2. Native `CGWindowID + pid` observation/focus and `/v2` window primitives.
3. Lease store, transaction core, `desktop_action`, screenshot MCP App result, and removal of advertised raw input.
4. Unit/contract/gated E2E tests plus developer scripts and migration documentation.
5. Follow-up: target-bound click/type/key/scroll and snapshot-coordinate contract.
6. Follow-up: Chrome and Android target adapters.
7. Follow-up: broker persistence, cancellation, confirmation tokens, standardized readiness/audit store.

The smallest next product step after this PR is target-bound `type`, `key`, `click`, and `scroll` using the same transaction, with click requiring a fresh snapshot ID. It exercises the architecture without widening the public taxonomy.
