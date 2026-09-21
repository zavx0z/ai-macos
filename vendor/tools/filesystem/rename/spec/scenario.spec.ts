import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {renamePath} from "../index.ts"

test("rename moves a file to a new path", () => fixture(directory => {
  const from = join(directory, "from"), to = join(directory, "to")
  writeFileSync(from, "data"); renamePath({from, to})
  assert.equal(existsSync(from), false)
  assert.equal(readFileSync(to, "utf8"), "data")
}))
test("rename moves between unrelated directories without aliases", () => fixture(a => fixture(b => {
  const from = join(a, "file"), to = join(b, "file")
  writeFileSync(from, "data")
  assert.deepEqual(renamePath({from, to}), {from, to, renamed: true})
  assert.equal(readFileSync(to, "utf8"), "data")
})))
test("rename does not overwrite an existing target", () => fixture(directory => {
  const from = join(directory, "a"), to = join(directory, "b")
  writeFileSync(from, "a"); writeFileSync(to, "b")
  assert.throws(() => renamePath({from, to}), hasCode("CONFLICT"))
  assert.equal(readFileSync(to, "utf8"), "b")
}))
test("rename rejects filesystem root and moving a directory into itself", () => fixture(directory => {
  const from = join(directory, "dir"); mkdirSync(from)
  assert.throws(() => renamePath({from: parse(directory).root, to: join(directory, "root")}), hasCode("PATH_NOT_ALLOWED"))
  assert.throws(() => renamePath({from, to: join(from, "nested")}), hasCode("INVALID_INPUT"))
}))
test("rename moves a final symlink as a link", () => fixture(directory => {
  writeFileSync(join(directory, "target"), "data"); symlinkSync("target", join(directory, "link"))
  renamePath({from: join(directory, "link"), to: join(directory, "moved")})
  assert.equal(readFileSync(join(directory, "target"), "utf8"), "data")
  assert.equal(readFileSync(join(directory, "moved"), "utf8"), "data")
}))
