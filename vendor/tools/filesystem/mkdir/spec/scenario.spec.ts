import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {makeDirectory} from "../index.ts"

test("mkdir recursive mode reports creation and idempotent repetition", () => fixture(directory => {
  const path = join(directory, "a/b")
  assert.equal(makeDirectory({path, recursive: true}).created, true)
  assert.equal(makeDirectory({path, recursive: true}).created, false)
  assert.equal(existsSync(path), true)
}))
test("mkdir refuses filesystem root and invalid recursive flag", () => fixture(directory => {
  assert.throws(() => makeDirectory({path: parse(directory).root}), hasCode("PATH_NOT_ALLOWED"))
  assert.throws(() => makeDirectory({path: join(directory, "a"), recursive: "true"} as never), hasCode("INVALID_INPUT"))
}))
