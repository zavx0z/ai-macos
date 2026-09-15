import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execute = promisify(execFile)
const root = resolve(fileURLToPath(new URL("../", import.meta.url)))

async function command(file: string, args: string[]) {
  return execute(file, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  })
}

async function installedHelper() {
  const path = join(root, "input/bin/meta-input-helper")
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) {
      return { path, state: "invalid-artifact", bytes: metadata.size }
    }
    const [content, signature, architectures] = await Promise.all([
      readFile(path),
      command("/usr/bin/codesign", ["--display", "--verbose=2", path]),
      command("/usr/bin/lipo", ["-archs", path]),
    ])
    await command("/usr/bin/codesign", ["--verify", "--strict", path])
    const fields = Object.fromEntries(signature.stderr.split("\n").flatMap(line => {
      const separator = line.indexOf("=")
      if (separator < 0) return []
      return [[line.slice(0, separator), line.slice(separator + 1)]]
    }))
    return {
      path,
      state: "artifact-verified",
      bytes: metadata.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      identifier: fields.Identifier ?? null,
      signature: fields.Signature ?? null,
      architectures: architectures.stdout.trim().split(/\s+/),
      modifiedAt: metadata.mtime.toISOString(),
      permissionsVerified: false,
      loadedBuildVerified: false,
    }
  } catch (error) {
    return { path, state: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function inspectSource() {
  const [canonicalRoot, head, tree, helper] = await Promise.all([
    realpath(root),
    command("git", ["rev-parse", "HEAD"]),
    command("git", ["status", "--porcelain=v1", "-z"]),
    installedHelper(),
  ])
  const dependencies = [
    ["@meta/shared/contracts", "mcp"],
    ["@meta/runtime", "mcp"],
    ["@meta/native", "runtime"],
    ["@meta/chrome/adapter", "runtime"],
    ["@meta/android/adapter", "runtime"],
    ["@meta/input/adapter", "input"],
    ["@meta/screen/native-driver", "screen"],
  ].map(([specifier, from]) => {
    try {
      return { specifier, state: "resolved", path: Bun.resolveSync(specifier!, join(root, from!)) }
    } catch (error) {
      return { specifier, state: "missing", reason: error instanceof Error ? error.message : String(error) }
    }
  })
  const expectedHostname = Bun.env.AI_MACOS_EXPECTED_HOSTNAME
  return {
    kind: "ai-macos-source-preflight",
    machine: {
      hostname: hostname(),
      expectedHostname: expectedHostname ?? null,
      matchesExpected: expectedHostname === undefined ? null : hostname() === expectedHostname,
      platform: process.platform,
      arch: process.arch,
    },
    checkout: { root: canonicalRoot, head: head.stdout.trim(), clean: tree.stdout.length === 0 },
    dependencies,
    helper,
    liveProbesPerformed: false,
    runtimeReadinessVerified: false,
  }
}

if (import.meta.main) {
  inspectSource().then(
    report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
