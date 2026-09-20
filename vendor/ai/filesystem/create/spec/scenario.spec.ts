import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {createFile} from "../index.ts"

test("create writes a new file and rejects a duplicate", () => fixture(directory => {
  const path = join(directory, "file")
  createFile({path, content: "hello"})
  assert.throws(() => createFile({path, content: "bad"}), hasCode("EEXIST"))
  assert.equal(readFileSync(path, "utf8"), "hello")
}))
test("create requires explicit parent creation", () => fixture(directory => {
  const path = join(directory, "a/file")
  assert.throws(() => createFile({path, content: ""}), hasCode("ENOENT"))
  assert.equal(existsSync(join(directory, "a")), false)
  createFile({path, content: "", createParents: true})
  assert.equal(existsSync(path), true)
}))
test("create validates input and byte budget before creating parents", () => fixture(directory => {
  const path = join(directory, "a/file")
  assert.throws(() => createFile({path, content: "!", encoding: "base64", createParents: true}), hasCode("INVALID_INPUT"))
  assert.throws(() => createFile({path, content: "x".repeat(8388609), createParents: true}), hasCode("LIMIT_EXCEEDED"))
  assert.equal(existsSync(join(directory, "a")), false)
}))
test("create rejects a dangling final or parent symlink", () => fixture(directory => {
  symlinkSync("missing", join(directory, "link"))
  assert.throws(() => createFile({path: join(directory, "link"), content: "x"}), hasCode("PATH_NOT_ALLOWED"))
  assert.throws(() => createFile({path: join(directory, "link/file"), content: "x", createParents: true}), hasCode("PATH_NOT_ALLOWED"))
  assert.equal(existsSync(join(directory, "missing")), false)
}))
