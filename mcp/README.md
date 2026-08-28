# ai-macos MCP

This direct MCP server supersedes the deprecated `ai-macos-local` connector,
which must not be used and remains an external archival gate.
Agent workflows use the direct `ai-macos` server configured in Codex and do
not fall back to the connector or call the REST services themselves.

The STDIO entrypoint is `src/launcher.ts`. Set
`AI_MACOS_EXPECTED_HOSTNAME` to the exact physical Mac hostname before use.
The server rejects all tools except passive `system_health` when the actual
hostname differs or no expected hostname is configured.

The launcher checks the local desktop REST services before starting the MCP
server:

- `@meta/window` on `127.0.0.1:7878`
- `@meta/screen` on `127.0.0.1:7879`
- `@meta/chrome` on `127.0.0.1:7880`
- `@meta/input` on `127.0.0.1:7882`

All missing desktop services are started concurrently when the MCP connects.
Existing compatible listeners are reused.
Existing incompatible listeners are preserved and surfaced as degraded state
through `system_health`; they are never replaced or treated as permission to
start a duplicate listener. Started services are detached from the MCP process
so a Codex MCP reconnect does not stop them. Service output is appended to
`logs/mcp-services/`.

Android remains opt-in and is not started by the desktop MCP launcher.

Window discovery and targeting use the same signed native helper as input.
`list_windows` returns exact process IDs, and every window-targeted MCP tool
accepts optional `pid` in addition to the existing `app`/`index`/`title`
selectors. Existing calls remain compatible; same-name processes fail closed
until the caller selects an exact visible target.

Typing requests are accepted only when their estimated duration is at most 30
seconds. This is not a hard native-helper deadline. An accepted typing dispatch
has no client-side REST timeout: MCP keeps the verified target focused and holds
the mutation guard until the helper responds. Cancellation is not yet propagated
into the helper, so callers must not retry or deliberately change focus until
its completion state is known.

Run manually with:

```sh
bun run --cwd mcp start
```

Set `AI_MACOS_REST_STARTUP_TIMEOUT_MS` to override the default 15-second REST
startup deadline.
