/**
 * Раскрывает package.json workspaces/exports и локальные контракты выбранного узла.
 * @remarks TypeScript читается как текст, а не исполняется. Контракты и сценарии
 * загружаются только по запросу. Не является копией runtime Storybook.
 * @packageDocumentation
 */
import {realpathSync} from "node:fs"
import {dirname} from "node:path"
import {ToolError} from "../../shared/errors.ts"
import {source as fileSource, overview} from "./src/read.ts"
import type {DiscoveryInput} from "./contract/input.ts"
import type {DiscoveryOutput} from "./contract/output.ts"
export type {DiscoveryInput} from "./contract/input.ts"
export type {DiscoveryOutput} from "./contract/output.ts"

export function createDiscovery(input: DiscoveryInput): DiscoveryOutput {
  const root = input.readSource ? input.repositoryRoot : realpathSync(input.repositoryRoot)
  const source = (root: string, name: string, optional = false) => input.readSource
    ? input.readSource(name, optional) : fileSource(root, name, optional)
  const manifest = JSON.parse(source(root, "package.json")!) as {name: string; label?: string; workspaces: string[]}
  const rootNode = manifest.name.split("/").at(-1)!
  if (!/^[a-z][a-z0-9-]*$/.test(rootNode) || !Array.isArray(manifest.workspaces)) throw new ToolError("INVALID_STRUCTURE", "Invalid root manifest", 500)
  const nodes = new Map<string, {name: string; label: string; directory: string; entry?: string; package: boolean}>()
  nodes.set(rootNode, {name: manifest.name, label: manifest.label ?? rootNode, directory: ".", package: true})
  for (const directory of manifest.workspaces) {
    if (!/^[a-z][a-z0-9-]*$/.test(directory)) throw new ToolError("INVALID_STRUCTURE", "Workspaces must be explicit root directories", 500)
    const pkg = JSON.parse(source(root, `${directory}/package.json`)!) as {name: string; label?: string; exports?: Record<string, string>}
    const node = `${rootNode}/${directory}`
    nodes.set(node, {name: pkg.name, label: pkg.label ?? directory, directory, package: true})
    for (const [key, entry] of Object.entries(pkg.exports ?? {})) {
      if (key === ".") continue
      if (!/^\.\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(key) || entry !== `${key}/index.ts`) throw new ToolError("INVALID_STRUCTURE", "Tools require explicit structural index.ts exports", 500)
      const segments = key.slice(2).split("/")
      for (let length = 1; length < segments.length; length++) {
        const suffix = segments.slice(0, length).join("/")
        const category = `${node}/${suffix}`
        if (!nodes.has(category)) nodes.set(category, {name: segments[length - 1]!, label: segments[length - 1]!, directory: `${directory}/${suffix}`, entry: `${directory}/${suffix}/index.ts`, package: false})
      }
      const address = `${node}/${key.slice(2)}`
      nodes.set(address, {name: key.slice(2), label: key.slice(2), directory: `${directory}/${dirname(entry)}`, entry: `${directory}/${entry}`, package: false})
    }
  }
  for (const address of input.runnable) if (!nodes.has(address)) throw new ToolError("INVALID_STRUCTURE", "An executable binding has no public export", 500)
  return {
    has: node => nodes.has(node),
    describe: (node = rootNode, view = "overview") => {
      if (typeof node !== "string" || node.length > 256 || !nodes.has(node)) throw new ToolError("UNKNOWN_NODE", "Unknown structural node", 404)
      const owner = nodes.get(node)!
      if (view === "contract") {
        const inputSource = source(root, `${owner.directory}/contract/input.ts`, true)
        const outputSource = source(root, `${owner.directory}/contract/output.ts`, true)
        if (inputSource === null && outputSource === null) throw new ToolError("VIEW_NOT_FOUND", "This node has no contract", 404)
        return {node, view, format: "typescript", input: inputSource, output: outputSource}
      }
      if (view === "scenarios") {
        const scenario = source(root, `${owner.directory}/spec/scenario.spec.ts`, true)
        if (scenario === null) throw new ToolError("VIEW_NOT_FOUND", "This node has no scenarios", 404)
        return {node, view, format: "typescript", executed: false, source: scenario}
      }
      if (view !== "overview") throw new ToolError("VIEW_NOT_FOUND", "Unknown view", 404)
      const children = [...nodes.entries()].filter(([address]) => address.startsWith(`${node}/`) && !address.slice(node.length + 1).includes("/"))
        .map(([address, child]) => ({node: address, label: child.label, runnable: input.runnable.has(address)}))
      const description = owner.package ? source(root, `${owner.directory}/README.md`, true) : overview(source(root, owner.entry!, true))
      const views = ["overview"]
      if (source(root, `${owner.directory}/contract/input.ts`, true) !== null || source(root, `${owner.directory}/contract/output.ts`, true) !== null) views.push("contract")
      if (source(root, `${owner.directory}/spec/scenario.spec.ts`, true) !== null) views.push("scenarios")
      return {node, name: owner.name, label: owner.label, description, runnable: input.runnable.has(node), children,
        actions: input.runnable.has(node) ? ["run"] : [], views}
    },
  }
}
