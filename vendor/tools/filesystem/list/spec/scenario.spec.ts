import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {listFiles} from "../index.ts"

test("list includes ordinary .git entries but does not traverse child symlinks", () => fixture(directory => {
  mkdirSync(join(directory, ".git")); writeFileSync(join(directory, ".git/config"), "data")
  mkdirSync(join(directory, "dir")); writeFileSync(join(directory, "dir/file"), "ok")
  symlinkSync("dir", join(directory, "link"))
  const paths = listFiles({path: directory, recursive: true}).entries.map(entry => entry.path)
  assert.ok(paths.includes(join(directory, "dir/file")))
  assert.ok(paths.includes(join(directory, ".git/config")))
  assert.ok(paths.includes(join(directory, "link")))
  assert.ok(!paths.some(path => path.startsWith(join(directory, "link") + "/")))
}))
test("list reports entry truncation", () => fixture(directory => {
  for (let i = 0; i < 5; i++) writeFileSync(join(directory, `${i}`), "")
  const result = listFiles({path: directory, maxEntries: 2})
  assert.equal(result.entries.length, 2)
  assert.equal(result.truncated, true)
}))
test("list reports depth-limited inventories", () => fixture(directory => {
  mkdirSync(join(directory, "a/b"), {recursive: true})
  writeFileSync(join(directory, "a/b/file"), "")
  const result = listFiles({path: directory, recursive: true, maxDepth: 1})
  assert.equal(result.depthLimited, true)
  assert.equal(result.truncated, true)
}))
test("list reports an empty directory as complete and requires an explicit path", () => fixture(directory => {
  const result = listFiles({path: directory})
  assert.deepEqual(result.entries, [])
  assert.equal(result.truncated, false)
  assert.throws(() => listFiles({} as never), hasCode("INVALID_INPUT"))
}))
