# ai-macos MCP

The STDIO entrypoint is `src/launcher.ts`. It ensures the local desktop REST
services are ready before starting the MCP server:

- `@meta/window` on `127.0.0.1:7878`
- `@meta/screen` on `127.0.0.1:7879`
- `@meta/chrome` on `127.0.0.1:7880`
- `@meta/input` on `127.0.0.1:7882`

Only missing services are started. Existing listeners are preserved. Started
services are detached from the MCP process so a Codex MCP reconnect does not
stop or duplicate them. Service output is appended to `logs/mcp-services/`.

Android remains opt-in and is not started by the desktop MCP launcher.

Run manually with:

```sh
bun run --cwd mcp start
```

Set `AI_MACOS_REST_STARTUP_TIMEOUT_MS` to override the default 15-second REST
startup deadline.
