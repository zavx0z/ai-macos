import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, existsSync, symlinkSync} from "node:fs"
import {join} from "node:path"
import {createRequestHandler} from "../index.ts"
import {directoryAuthorizer} from "../src/authorize.ts"
import {startServer} from "../../index.ts"
import {fixture, hasCode} from "../../../filesystem/shared/spec-fixture.ts"
import {repositoryRoot, token, post} from "./fixture.ts"

const appFor = (directory: string) => createRequestHandler({authorize: directoryAuthorizer([directory]), token, repositoryRoot})
const run = (name: string, input: Record<string, unknown>) => post({node: `tools/filesystem/${name}`, action: "run", input})

test("HTTP GET and empty POST discover the same root", () => fixture(async directory => {
  const app = appFor(directory)
  const get = await app.handle(new Request("http://localhost/tools", {headers: {authorization: `Bearer ${token}`}}))
  const empty = await app.handle(post({}))
  assert.equal(get.status, 200)
  assert.deepEqual(await get.json(), await empty.json())
}))
test("HTTP requires a token even for discovery", () => fixture(async directory => {
  const response = await appFor(directory).handle(new Request("http://localhost/tools"))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("www-authenticate"), "Bearer")
  assert.equal((await response.json()).error.code, "UNAUTHORIZED")
}))
test("HTTP discovers contracts and scenarios without executing", () => fixture(async directory => {
  const path = join(directory, "file")
  writeFileSync(path, "unchanged")
  const app = appFor(directory)
  assert.equal((await (await app.handle(post({node: "tools/filesystem/write"}))).json()).runnable, true)
  const contract = await app.handle(post({node: "tools/filesystem/write", input: {view: "contract"}}))
  assert.match((await contract.json()).input, /expectedHash/)
  const scenario = await app.handle(post({node: "tools/filesystem/write", input: {view: "scenarios"}}))
  assert.equal((await scenario.json()).executed, false)
  assert.equal(readFileSync(path, "utf8"), "unchanged")
}))
test("HTTP executes the real public function with an absolute path", () => fixture(async directory => {
  const path = join(directory, "file")
  writeFileSync(path, "hello")
  const response = await appFor(directory).handle(run("read", {path}))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).content, "hello")
}))
test("HTTP rejects imports, technical nodes, removed tools and invalid envelopes", () => fixture(async directory => {
  const app = appFor(directory)
  for (const [body, status] of [
    [{node: "../../etc/passwd", action: "run"}, 404],
    [{node: "tools/server/request", action: "run"}, 403],
    [{node: "tools/server/dispatch", action: "run"}, 403],
    [{node: "tools/filesystem/roots"}, 404],
    [{node: "tools/filesystem/open", action: "run"}, 404],
    [{node: "tools/filesystem/read", action: "execute"}, 400],
    [{node: "tools/filesystem/read", input: {path: join(directory, "file")}}, 400],
    [{node: "tools/filesystem/read", action: "run", input: []}, 400],
    [{extra: true}, 400], [[], 400],
  ] as const) assert.equal((await app.handle(post(body))).status, status)
}))
test("HTTP distinguishes missing paths, conflicts and denied directories", () => fixture(async directory => fixture(async outside => {
  const path = join(directory, "existing")
  writeFileSync(path, "old")
  const app = appFor(directory)
  assert.equal((await app.handle(run("read", {path: join(directory, "missing")}))).status, 404)
  assert.equal((await app.handle(run("create", {path, content: "new"}))).status, 409)
  const denied = await app.handle(run("create", {path: join(outside, "private"), content: "bad"}))
  assert.equal(denied.status, 403)
  assert.equal(existsSync(join(outside, "private")), false)
  assert.equal(readFileSync(path, "utf8"), "old")
})))
test("HTTP rejects unsupported methods, media types and browser origins", () => fixture(async directory => {
  const app = appFor(directory)
  assert.equal((await app.handle(new Request("http://localhost/tools", {method: "DELETE", headers: {authorization: `Bearer ${token}`}}))).status, 405)
  assert.equal((await app.handle(post({}, {"content-type": "text/plain"}))).status, 415)
  assert.equal((await app.handle(post({}, {origin: "https://untrusted.invalid"}))).status, 403)
  assert.equal((await app.handle(new Request("http://localhost/v1/tools", {headers: {authorization: `Bearer ${token}`}}))).status, 404)
}))
test("HTTP rejects malformed JSON and oversized bodies", () => fixture(async directory => {
  const app = appFor(directory)
  const invalid = new Request("http://localhost/tools", {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: "{"})
  assert.equal((await app.handle(invalid)).status, 400)
  assert.equal((await app.handle(post({}, {"content-length": "13000000"}))).status, 413)
  const large = new Request("http://localhost/tools", {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: "x".repeat(12 * 1024 * 1024 + 1)})
  assert.equal((await app.handle(large)).status, 413)
}))
test("HTTP logs operation metadata, not file contents or credentials", () => fixture(async directory => {
  const logs: unknown[] = []
  const app = createRequestHandler({authorize: directoryAuthorizer([directory]), token, repositoryRoot, logger: event => logs.push(event)})
  const response = await app.handle(run("create", {path: join(directory, "file"), content: "private-content-marker"}))
  assert.equal(response.status, 200)
  const encoded = JSON.stringify(logs)
  assert.equal(encoded.includes(token), false)
  assert.equal(encoded.includes("private-content-marker"), false)
  assert.ok(encoded.includes(response.headers.get("x-request-id")!))
}))
test("diagnostics failure does not invalidate a completed write", () => fixture(async directory => {
  const app = createRequestHandler({authorize: directoryAuthorizer([directory]), token, repositoryRoot, logger: () => {throw new Error("logger unavailable")}})
  const path = join(directory, "file")
  assert.equal((await app.handle(run("create", {path, content: "ok"}))).status, 200)
  assert.equal(readFileSync(path, "utf8"), "ok")
}))
test("HTTP construction rejects a weak token", () => {
  assert.throws(() => createRequestHandler({token: "short", repositoryRoot}), hasCode("INVALID_INPUT"))
})
test("real loopback listener reads through the same tools without Interpreter", () => fixture(async directory => {
  const path = join(directory, "file")
  writeFileSync(path, "network")
  const host = await startServer({allowedDirectories: [directory], token, repositoryRoot, port: 0, log: false})
  try {
    const response = await fetch(host.url, {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
      body: JSON.stringify({node: "tools/filesystem/read", action: "run", input: {path}})})
    assert.equal(response.status, 200)
    assert.equal((await response.json()).content, "network")
  } finally { await host.close() }
}))
test("valid Bearer token alone cannot bypass absent execution authority", () => fixture(async directory => {
  const path = join(directory, "file")
  const app = createRequestHandler({token, repositoryRoot})
  const response = await app.handle(run("create", {path, content: "bad"}))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, "AUTHORIZATION_REQUIRED")
  assert.equal(existsSync(path), false)
}))
test("HTTP policy checks physical parent paths and both rename endpoints", () => fixture(async directory => fixture(async outside => {
  symlinkSync(outside, join(directory, "escape"))
  const app = appFor(directory)
  assert.equal((await app.handle(run("create", {path: join(directory, "escape/file"), content: "bad"}))).status, 403)
  const from = join(directory, "from")
  const to = join(outside, "to")
  writeFileSync(from, "safe")
  assert.equal((await app.handle(run("rename", {from, to}))).status, 403)
  assert.equal(readFileSync(from, "utf8"), "safe")
  assert.equal(existsSync(to), false)
  assert.equal(existsSync(join(outside, "file")), false)
})))
test("HTTP policy protects its configured directory entry", () => fixture(async directory => {
  const app = appFor(directory)
  assert.equal((await app.handle(run("remove", {path: directory, recursive: true}))).status, 403)
  assert.equal((await app.handle(run("rename", {from: directory, to: directory + "-new"}))).status, 403)
  assert.equal(existsSync(directory), true)
}))
test("HTTP patch may use a permitted directory without registration calls", () => fixture(async directory => {
  const response = await appFor(directory).handle(run("apply-patch", {directory, patch: "*** Begin Patch\n*** Add File: file\n+ok\n*** End Patch"}))
  assert.equal(response.status, 200)
  assert.equal(readFileSync(join(directory, "file"), "utf8"), "ok\n")
}))
test("server rejects absent permissions and legacy root config before listening", () => fixture(async directory => {
  await assert.rejects(startServer({token, repositoryRoot, port: 0} as never), hasCode("INVALID_INPUT"))
  await assert.rejects(startServer({roots: {repo: directory}, token, repositoryRoot, port: 0} as never), hasCode("INVALID_INPUT"))
  assert.throws(() => directoryAuthorizer([]), hasCode("INVALID_INPUT"))
}))
