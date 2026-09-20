import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {writeFile} from "../index.ts"
import {readFile} from "../../read/index.ts"

test("write replaces a file and preserves its permissions", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "before"); chmodSync(path, 0o660)
  const result = writeFile({path, content: "after"})
  assert.equal(readFileSync(path, "utf8"), "after")
  assert.equal(result.bytes, 5)
  assert.equal(statSync(path).mode & 0o777, 0o660)
  assert.deepEqual(readdirSync(directory), ["file"])
}))
test("write rejects stale expectedHash without changing contents", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "before")
  const expectedHash = readFile({path}).contentHash!
  writeFile({path, content: "after", expectedHash})
  assert.throws(() => writeFile({path, content: "bad", expectedHash}), hasCode("CONFLICT"))
  assert.equal(readFileSync(path, "utf8"), "after")
}))
test("write accepts empty contents but does not create missing files", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "before"); writeFile({path, content: ""})
  assert.equal(statSync(path).size, 0)
  assert.throws(() => writeFile({path: join(directory, "missing"), content: ""}), hasCode("ENOENT"))
}))
test("write rejects symlinks and non-canonical base64", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "before"); symlinkSync("file", join(directory, "link"))
  assert.throws(() => writeFile({path: join(directory, "link"), content: "bad"}), hasCode("PATH_NOT_ALLOWED"))
  for (const content of ["abc", "!!!!", "Zh=="]) assert.throws(() => writeFile({path, content, encoding: "base64"}), hasCode("INVALID_INPUT"))
  assert.equal(readFileSync(path, "utf8"), "before")
}))
test("write rejects removed root input before touching a file", () => fixture(directory => {
  const path = join(directory, "file"); writeFileSync(path, "before")
  assert.throws(() => writeFile({path, content: "bad", root: "repo"} as never), hasCode("INVALID_INPUT"))
  assert.equal(readFileSync(path, "utf8"), "before")
}))
