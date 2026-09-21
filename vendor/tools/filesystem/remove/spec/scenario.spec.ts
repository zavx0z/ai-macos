import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {removePath} from "../index.ts"

test("remove requires explicit recursion for a nonempty directory", () => fixture(directory => {
  const path = join(directory, "dir")
  mkdirSync(path); writeFileSync(join(path, "file"), "x")
  assert.throws(() => removePath({path}))
  assert.equal(existsSync(join(path, "file")), true)
  removePath({path, recursive: true})
  assert.equal(existsSync(path), false)
}))
test("remove unlinks a final symlink without deleting its target", () => fixture(directory => {
  writeFileSync(join(directory, "target"), "x"); symlinkSync("target", join(directory, "link"))
  removePath({path: join(directory, "link")})
  assert.equal(existsSync(join(directory, "target")), true)
}))
test("remove protects the filesystem root and reports repeated deletion", () => fixture(directory => {
  assert.throws(() => removePath({path: parse(directory).root, recursive: true}), hasCode("PATH_NOT_ALLOWED"))
  const path = join(directory, "file"); writeFileSync(path, "x")
  removePath({path})
  assert.throws(() => removePath({path}), hasCode("ENOENT"))
}))
