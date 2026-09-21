import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {statPath} from "../index.ts"

test("stat reports file and directory metadata by absolute path", () => fixture(directory => {
  const path = join(directory, "file.txt")
  writeFileSync(path, "abc")
  assert.equal(statPath({path}).entry.size, 3)
  assert.equal(statPath({path: directory}).entry.type, "directory")
  assert.equal(statPath({path}).entry.path, path)
}))
test("stat describes a terminal symlink without exposing its target", () => fixture(directory => {
  symlinkSync("missing-outside-target", join(directory, "link"))
  const result = statPath({path: join(directory, "link")})
  assert.equal(result.entry.type, "symlink")
  assert.equal(JSON.stringify(result).includes("outside-target"), false)
}))
test("stat has no hard-coded Git metadata policy", () => fixture(directory => {
  mkdirSync(join(directory, ".git"))
  writeFileSync(join(directory, ".git/config"), "x")
  assert.equal(statPath({path: join(directory, ".git/config")}).entry.size, 1)
}))
