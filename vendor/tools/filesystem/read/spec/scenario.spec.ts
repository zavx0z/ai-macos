import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {readFile} from "../index.ts"

test("read needs only an absolute path and reports a complete file/hash", () => fixture(directory => {
  const path = join(directory, "hello.txt")
  writeFileSync(path, "hello")
  const result = readFile({path})
  assert.equal(result.path, path)
  assert.equal(result.content, "hello")
  assert.equal(result.bytesRead, 5)
  assert.equal(result.truncated, false)
  assert.match(result.contentHash!, /^[a-f0-9]{64}$/)
  assert.equal("root" in result, false)
}))
test("read reports byte-range truncation without a whole-file hash", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "abcdef")
  const result = readFile({path, offset: 1, maxBytes: 2})
  assert.equal(result.content, "bc")
  assert.equal(result.bytesRead, 2)
  assert.equal(result.contentHash, null)
  assert.equal(result.truncated, true)
}))
test("read handles empty files and offsets beyond EOF", () => fixture(directory => {
  const path = join(directory, "empty")
  writeFileSync(path, "")
  assert.equal(readFile({path}).bytesRead, 0)
  const result = readFile({path, offset: 100})
  assert.equal(result.truncated, false)
  assert.equal(result.contentHash, null)
}))
test("read base64 preserves binary and split UTF-8 bytes", () => fixture(directory => {
  const path = join(directory, "binary")
  const bytes = Buffer.from([0, 255, 1, 128])
  writeFileSync(path, bytes)
  const result = readFile({path, encoding: "base64", offset: 1, maxBytes: 2})
  assert.deepEqual(Buffer.from(result.content, "base64"), bytes.subarray(1, 3))
}))
for (const path of ["relative", "../secret", "", "~/.config", "bad\0name"]) {
  test(`read never infers a directory for ${JSON.stringify(path)}`, () => {
    assert.throws(() => readFile({path}), hasCode(path === "" ? "INVALID_INPUT" : "PATH_NOT_ALLOWED"))
  })
}
test("read allows an ordinary .git-named file and normalizes an absolute path", () => fixture(directory => {
  mkdirSync(join(directory, ".git"))
  writeFileSync(join(directory, ".git/config"), "ordinary data")
  assert.equal(readFile({path: join(directory, ".git/config")}).content, "ordinary data")
  assert.equal(readFile({path: `${directory}/unused/../.git/config`}).content, "ordinary data")
}))
test("read rejects a final symlink but canonicalizes existing parent aliases", () => fixture(directory => {
  mkdirSync(join(directory, "real"))
  writeFileSync(join(directory, "real/file"), "data")
  symlinkSync("real/file", join(directory, "link"))
  symlinkSync("real", join(directory, "alias"))
  assert.throws(() => readFile({path: join(directory, "link")}), hasCode("PATH_NOT_ALLOWED"))
  const result = readFile({path: join(directory, "alias/file")})
  assert.equal(result.content, "data")
  assert.equal(result.path, join(directory, "real/file"))
}))
test("read validates numbers, encoding, input shape, legacy root and target type", () => fixture(directory => {
  const path = join(directory, "file")
  writeFileSync(path, "data")
  for (const extra of [{maxBytes: 0}, {maxBytes: 8388609}, {offset: -1}, {offset: 1.5}, {encoding: "latin1"}, {root: "repo"}]) {
    assert.throws(() => readFile({path, ...extra} as never), hasCode("INVALID_INPUT"))
  }
  assert.throws(() => readFile(null as never), hasCode("INVALID_INPUT"))
  assert.throws(() => readFile({path: directory}), hasCode("INVALID_PATH_TYPE"))
  assert.throws(() => readFile({path: `${directory}/bad\0name`}), hasCode("PATH_NOT_ALLOWED"))
  assert.throws(() => readFile({path: `${directory}/${"x".repeat(4096)}`}), hasCode("PATH_NOT_ALLOWED"))
}))
