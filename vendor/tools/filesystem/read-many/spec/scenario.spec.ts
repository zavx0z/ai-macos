import {test} from "node:test"
import assert from "node:assert/strict"
import {writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, statSync, readdirSync} from "node:fs"
import {join, parse} from "node:path"
import {fixture, hasCode} from "../../shared/spec-fixture.ts"
import {readFiles} from "../index.ts"

test("read-many enforces its shared byte budget", () => fixture(directory => {
  const a = join(directory, "a"), b = join(directory, "b")
  writeFileSync(a, "1234"); writeFileSync(b, "5678")
  const result = readFiles({paths: [a, b, a], maxTotalBytes: 5})
  assert.equal(result.bytesRead, 5)
  assert.equal(result.remainingBytes, 0)
  assert.equal(result.truncated, true)
  assert.ok("error" in result.files[2]!)
}))
test("read-many preserves per-file errors and successes", () => fixture(directory => {
  const path = join(directory, "ok")
  writeFileSync(path, "yes")
  const result = readFiles({paths: [join(directory, "missing"), path]})
  assert.ok("error" in result.files[0]!)
  assert.ok("result" in result.files[1]!)
  assert.equal(result.bytesRead, 3)
}))
test("read-many works across unrelated directories without a context", () => fixture(a => fixture(b => {
  writeFileSync(join(a, "a"), "one"); writeFileSync(join(b, "b"), "two")
  const result = readFiles({paths: [join(a, "a"), join(b, "b")]})
  assert.equal(result.bytesRead, 6)
  assert.equal(result.truncated, false)
  assert.equal("root" in result, false)
})))
test("read-many rejects invalid batches before reading", () => {
  for (const paths of [[], Array(51).fill("x"), [1]]) {
    assert.throws(() => readFiles({paths} as never), hasCode("INVALID_INPUT"))
  }
})
