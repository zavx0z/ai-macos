import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs"
import {join} from "node:path"
import {createDiscovery} from "../index.ts"
import {bindings} from "../../dispatch/src/bindings.ts"
import {fixture, hasCode} from "../../../filesystem/shared/spec-fixture.ts"
import {repositoryRoot} from "../../request/spec/fixture.ts"

test("all eleven bindings have colocated contracts and executable scenarios", () => {
  const handlers = bindings()
  assert.equal(handlers.size, 11)
  for (const node of handlers.keys()) {
    const path = node.split("/").slice(1).join("/")
    for (const file of ["index.ts", "contract/input.ts", "contract/output.ts", "spec/scenario.spec.ts"]) {
      assert.equal(existsSync(join(repositoryRoot, path, file)), true, `${node}/${file}`)
    }
  }
  const discovery = createDiscovery({repositoryRoot, runnable: new Set(handlers.keys())})
  assert.equal(discovery.has("ai/filesystem/read"), true)
  for (const node of ["ai/filesystem/roots", "ai/filesystem/open", "ai/filesystem/shared"]) {
    assert.equal(discovery.has(node), false)
    assert.throws(() => discovery.describe(node), hasCode("UNKNOWN_NODE"))
  }
})
test("discovery supports nested addresses without executing source", () => fixture(directory => {
  writeFileSync(join(directory, "package.json"), JSON.stringify({name: "@test/ai", workspaces: ["filesystem"]}))
  mkdirSync(join(directory, "filesystem/group/tool"), {recursive: true})
  writeFileSync(join(directory, "filesystem/package.json"), JSON.stringify({name: "@test/filesystem", exports: {"./group/tool": "./group/tool/index.ts"}}))
  writeFileSync(join(directory, "filesystem/group/tool/index.ts"), "/** Safe description. @packageDocumentation */\nthrow new Error('must not execute')\n")
  const discovery = createDiscovery({repositoryRoot: directory, runnable: new Set(["ai/filesystem/group/tool"])})
  const category = discovery.describe("ai/filesystem/group") as {children: Array<{node: string}>}
  assert.equal(category.children[0]?.node, "ai/filesystem/group/tool")
  const tool = discovery.describe("ai/filesystem/group/tool") as {description: string; views: string[]}
  assert.equal(tool.description, "Safe description.")
  assert.deepEqual(tool.views, ["overview"])
}))
test("manifests have no runtime dependency on Interpreter, UI, browser or Storybook", () => {
  for (const path of ["package.json", "filesystem/package.json", "git/package.json", "server/package.json"]) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"))
    assert.equal(manifest.dependencies, undefined)
  }
})
