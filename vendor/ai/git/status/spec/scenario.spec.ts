import {test} from "node:test"
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {writeFileSync, mkdirSync} from "node:fs"
import {join} from "node:path"
import {gitStatus} from "../index.ts"
import {fixture, hasCode} from "../../../filesystem/shared/spec-fixture.ts"

test("status reads untracked names without shell parsing", () => fixture(directory => {
  assert.equal(spawnSync("git", ["init", "-q"], {cwd: directory}).status, 0)
  writeFileSync(join(directory, "unusual name\n.txt"), "data")
  const result = gitStatus({path: directory})
  assert.equal(result.entries[0]?.path, "unusual name\n.txt")
  assert.equal(result.entries[0]?.index, "?")
  assert.equal(result.truncated, false)
  assert.equal(result.path, directory)
}))
test("status parses staged renames as destination then source", () => fixture(directory => {
  const git = (...args: string[]): void => {assert.equal(spawnSync("git", args, {cwd: directory, env: {...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid"}}).status, 0)}
  git("init", "-q")
  writeFileSync(join(directory, "old name"), "unchanged contents")
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture"); git("mv", "old name", "new name")
  const result = gitStatus({path: directory})
  assert.equal(result.entries[0]?.path, "new name")
  assert.equal(result.entries[0]?.originalPath, "old name")
}))
test("status never falls back to an ancestor repository", () => fixture(directory => {
  assert.equal(spawnSync("git", ["init", "-q"], {cwd: directory}).status, 0)
  mkdirSync(join(directory, "nested"))
  assert.throws(() => gitStatus({path: join(directory, "nested")}), hasCode("NOT_A_REPOSITORY"))
}))
test("status reports a bounded result", () => fixture(directory => {
  assert.equal(spawnSync("git", ["init", "-q"], {cwd: directory}).status, 0)
  writeFileSync(join(directory, "a"), "a"); writeFileSync(join(directory, "b"), "b")
  const result = gitStatus({path: directory, maxEntries: 1})
  assert.equal(result.entries.length, 1)
  assert.equal(result.truncated, true)
}))
