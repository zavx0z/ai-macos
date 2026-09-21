import {test} from "node:test"
import assert from "node:assert/strict"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {createDispatcher} from "../index.ts"
import type {ToolInvocation} from "../contract/input.ts"
import {fixture, hasCode} from "../../../filesystem/shared/spec-fixture.ts"
import {repositoryRoot} from "../../request/spec/fixture.ts"

const create = (path: string) => ({node: "tools/filesystem/create", action: "run" as const, input: {path, content: "new"}})

test("embedded discovery never needs approval and never executes", () => fixture(async directory => {
  let calls = 0
  const app = createDispatcher({repositoryRoot, authorize: () => {calls++; return true}})
  const overview = await app.dispatch({node: "tools/filesystem/create"}) as {runnable: boolean}
  assert.equal(overview.runnable, true)
  const contract = await app.dispatch({node: "tools/filesystem/create", input: {view: "contract"}}) as {input: string}
  assert.match(contract.input, /path: string/)
  assert.doesNotMatch(contract.input, /root:/)
  const scenario = await app.dispatch({node: "tools/filesystem/create", input: {view: "scenarios"}}) as {executed: boolean}
  assert.equal(scenario.executed, false)
  assert.equal(calls, 0)
  assert.equal(existsSync(join(directory, "file")), false)
}))
test("embedded execution is denied by default, not implied by discovery", () => fixture(async directory => {
  const app = createDispatcher({repositoryRoot})
  await app.dispatch({node: "tools/filesystem/create"})
  await assert.rejects(app.dispatch(create(join(directory, "file"))), hasCode("AUTHORIZATION_REQUIRED"))
  assert.equal(existsSync(join(directory, "file")), false)
}))
test("false, undefined and failed host approval never execute", () => fixture(async directory => {
  for (const authorize of [() => false, () => undefined, () => {throw new Error("policy unavailable")}]) {
    const app = createDispatcher({repositoryRoot, authorize: authorize as never})
    await assert.rejects(app.dispatch(create(join(directory, "file"))))
    assert.equal(existsSync(join(directory, "file")), false)
  }
}))
test("embedded execution uses direct tool input and returns the public result", () => fixture(async directory => {
  const path = join(directory, "file")
  const invocations: ToolInvocation[] = []
  const app = createDispatcher({repositoryRoot, authorize: invocation => {invocations.push(invocation); return true}})
  await app.dispatch(create(path))
  const result = await app.dispatch({node: "tools/filesystem/read", action: "run", input: {path}}) as {path: string; content: string}
  assert.equal(result.path, path)
  assert.equal(result.content, "new")
  assert.deepEqual(invocations.map(item => item.effect), ["write", "read"])
  assert.deepEqual(invocations[0]!.paths, [path])
}))
test("arguments cannot change while asynchronous approval is pending", () => fixture(async directory => {
  const first = join(directory, "approved")
  const other = join(directory, "not-approved")
  const request = create(first)
  let entered!: () => void
  const pending = new Promise<void>(done => {entered = done})
  let release!: (value: boolean) => void
  const approval = new Promise<boolean>(done => {release = done})
  const app = createDispatcher({repositoryRoot, authorize: invocation => {
    assert.equal(Object.isFrozen(invocation), true)
    assert.equal(Object.isFrozen(invocation.input), true)
    assert.equal(Object.isFrozen(invocation.paths), true)
    assert.throws(() => { (invocation.input as Record<string, unknown>)["path"] = other }, TypeError)
    entered()
    return approval
  }})
  const result = app.dispatch(request)
  await pending
  request.input.path = other
  request.input.content = "changed"
  release(true)
  await result
  assert.equal(readFileSync(first, "utf8"), "new")
  assert.equal(existsSync(other), false)
}))
test("read-many arrays are detached and deeply frozen during approval", () => fixture(async directory => {
  const path = join(directory, "file")
  writeFileSync(path, "ok")
  const paths = [path]
  const app = createDispatcher({repositoryRoot, authorize: invocation => {
    assert.equal(Object.isFrozen(invocation.input["paths"]), true)
    paths[0] = join(directory, "missing")
    return true
  }})
  const result = await app.dispatch({node: "tools/filesystem/read-many", action: "run", input: {paths}}) as {files: {result: {content: string}}[]}
  assert.equal(result.files[0]!.result.content, "ok")
}))
test("patch dryRun is classified as read and creates no directory", () => fixture(async directory => {
  let effect: string | undefined
  const app = createDispatcher({repositoryRoot, authorize: invocation => {effect = invocation.effect; return true}})
  await app.dispatch({node: "tools/filesystem/apply-patch", action: "run", input: {
    directory, dryRun: true, patch: "*** Begin Patch\n*** Add File: new/file\n+x\n*** End Patch",
  }})
  assert.equal(effect, "read")
  assert.equal(existsSync(join(directory, "new")), false)
}))
test("removed tools and arbitrary executable nodes are rejected", async () => {
  const app = createDispatcher({repositoryRoot, authorize: () => true})
  for (const node of ["tools/filesystem/roots", "tools/filesystem/open", "../../etc/passwd"]) {
    await assert.rejects(app.dispatch({node}), hasCode("UNKNOWN_NODE"))
    await assert.rejects(app.dispatch({node, action: "run"}), hasCode("UNKNOWN_NODE"))
  }
  await assert.rejects(app.dispatch({node: "tools/server/dispatch", action: "run"}), hasCode("ACTION_NOT_ALLOWED"))
})
test("request cannot supply authority or override the explicit run action", () => fixture(async directory => {
  const app = createDispatcher({repositoryRoot, authorize: () => true})
  await assert.rejects(app.dispatch({...create(join(directory, "file")), authorize: true} as never), hasCode("INVALID_INPUT"))
  await assert.rejects(app.dispatch({...create(join(directory, "file")), action: "execute"} as never), hasCode("ACTION_NOT_ALLOWED"))
  await assert.rejects(app.dispatch({...create(join(directory, "file")), input: {path: join(directory, "file"), root: "repo", content: "x"}}), hasCode("INVALID_INPUT"))
  assert.equal(existsSync(join(directory, "file")), false)
}))
