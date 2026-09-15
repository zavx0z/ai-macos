# Clipboard regression checks

`clipboard.test.ts` mocks the subprocess boundary. It verifies UTF-8 locale and
multilingual payload handling without reading or replacing the system clipboard.

```sh
bun test input/tests/clipboard.test.ts input/tests/clipboard-live-gate.test.ts
```

The opt-in integration check from the computer-use workstream is retained in
`clipboard.live.test.ts`. It is skipped by default. Enabling
`AI_MACOS_LIVE_CLIPBOARD=true` requires explicit authorization to inspect and
replace the current general clipboard; restoring text does not restore other
clipboard formats. Do not enable it as part of ordinary tests or a source merge.

The September15 Dzen verification uses the direct MCP write and a visible Paste
menu on already approved article text. Source integration does not activate the
new Runtime/native broker or replace installed helpers.
