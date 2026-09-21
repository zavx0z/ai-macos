import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {applyPatch} from "../index.ts"

test("patch adds, updates, moves and deletes regular files", () => fixture(directory => {
  writeFileSync(join(directory, "old"), "before\n"); writeFileSync(join(directory, "delete"), "gone\n")
  const patch = "*** Begin Patch\n*** Add File: dir/added\n+hello\n*** Update File: old\n*** Move to: moved\n@@\n-before\n+after\n*** Delete File: delete\n*** End Patch\n"
  const result = applyPatch({directory, patch})
  assert.equal(result.applied, true)
  assert.equal(result.directory, directory)
  assert.deepEqual(result.changes.map(change => change.operation), ["add", "move", "delete"])
  assert.equal(readFileSync(join(directory, "moved"), "utf8"), "after\n")
  assert.equal(readFileSync(join(directory, "dir/added"), "utf8"), "hello\n")
  assert.equal(existsSync(join(directory, "old")), false)
  assert.equal(existsSync(join(directory, "delete")), false)
}))
test("patch dryRun performs no writes or parent creation", () => fixture(directory => {
  const result = applyPatch({directory, dryRun: true, patch: "*** Begin Patch\n*** Add File: new/file\n+x\n*** End Patch"})
  assert.equal(result.applied, false)
  assert.equal(existsSync(join(directory, "new")), false)
}))
test("patch preflights all hunks before writing any file", () => fixture(directory => {
  writeFileSync(join(directory, "existing"), "actual\n")
  const patch = "*** Begin Patch\n*** Add File: new/file\n+x\n*** Update File: existing\n@@\n-wrong\n+bad\n*** End Patch"
  assert.throws(() => applyPatch({directory, patch}), hasCode("PATCH_REJECTED"))
  assert.equal(existsSync(join(directory, "new")), false)
  assert.equal(readFileSync(join(directory, "existing"), "utf8"), "actual\n")
}))
test("patch refuses ambiguous contexts and duplicate paths", () => fixture(directory => {
  writeFileSync(join(directory, "file"), "x\nx\n")
  assert.throws(() => applyPatch({directory, patch: "*** Begin Patch\n*** Update File: file\n@@\n-x\n+y\n*** End Patch"}), hasCode("PATCH_REJECTED"))
  assert.throws(() => applyPatch({directory, patch: "*** Begin Patch\n*** Add File: new\n+x\n*** Add File: new\n+y\n*** End Patch"}), hasCode("PATCH_REJECTED"))
  assert.equal(existsSync(join(directory, "new")), false)
}))
test("patch preserves CRLF and a missing final newline", () => fixture(directory => {
  for (const [name, before, after] of [["crlf", "before\r\n", "after\r\n"], ["plain", "before", "after"]]) {
    writeFileSync(join(directory, name!), before!)
    applyPatch({directory, patch: `*** Begin Patch\n*** Update File: ${name}\n@@\n-before\n+after\n*** End Patch`})
    assert.equal(readFileSync(join(directory, name!), "utf8"), after)
  }
}))
test("patch End of File anchors the replacement", () => fixture(directory => {
  writeFileSync(join(directory, "file"), "x\nx\n")
  applyPatch({directory, patch: "*** Begin Patch\n*** Update File: file\n@@\n-x\n+y\n*** End of File\n*** End Patch"})
  assert.equal(readFileSync(join(directory, "file"), "utf8"), "x\ny\n")
}))
test("patch rejects traversal before changing a valid earlier file", () => fixture(directory => {
  assert.throws(() => applyPatch({directory, patch: "*** Begin Patch\n*** Add File: good\n+x\n*** Add File: ../outside\n+y\n*** End Patch"}), hasCode("PATH_NOT_ALLOWED"))
  assert.equal(existsSync(join(directory, "good")), false)
}))
test("patch rejects invalid UTF-8 input files", () => fixture(directory => {
  writeFileSync(join(directory, "binary"), Buffer.from([255]))
  assert.throws(() => applyPatch({directory, patch: "*** Begin Patch\n*** Update File: binary\n@@\n-a\n+b\n*** End Patch"}), hasCode("PATCH_REJECTED"))
}))
test("patch rejects a symlink escape before any write", () => fixture(directory => fixture(outside => {
  symlinkSync(outside, join(directory, "alias"))
  assert.throws(() => applyPatch({directory, patch: "*** Begin Patch\n*** Add File: good\n+x\n*** Add File: alias/bad\n+y\n*** End Patch"}), hasCode("PATH_NOT_ALLOWED"))
  assert.equal(existsSync(join(directory, "good")), false)
  assert.equal(existsSync(join(outside, "bad")), false)
})))
test("patch reports completed and current operations after an I/O failure", () => fixture(directory => {
  // Existing planner semantics: parent/child conflicts may reach the I/O phase.
  let failure: unknown
  try { applyPatch({directory, patch: "*** Begin Patch\n*** Add File: a\n+x\n*** Add File: a/b\n+y\n*** End Patch"}) } catch (error) { failure = error }
  assert.ok(hasCode("PARTIAL_FAILURE")(failure))
  const details = (failure as {details: {completed: {path: string}[]; current: {path: string}}}).details
  assert.equal(details.completed.length, 1)
  assert.equal(details.completed[0]?.path, join(directory, "a"))
  assert.equal(details.current.path, join(directory, "a/b"))
  assert.equal(readFileSync(join(directory, "a"), "utf8"), "x\n")
}))
