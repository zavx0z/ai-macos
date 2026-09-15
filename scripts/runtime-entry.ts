/** Один immutable executable содержит runtime supervisor и thin MCP client. */
if (process.argv.includes("--mcp")) {
  const { main } = await import("../mcp/src/runtime-mcp.ts")
  await main()
} else {
  const { main } = await import("../runtime/src/server.ts")
  await main()
}
