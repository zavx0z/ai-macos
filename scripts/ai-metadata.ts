import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = fileURLToPath(new URL("../vendor/ai/", import.meta.url))
const destination = fileURLToPath(new URL("../mcp/src/ai-metadata.ts", import.meta.url))

/** Производная упаковка исходников, не второй каталог контрактов. */
export function renderAiMetadata(root = sourceRoot): string {
  const sources: Record<string, string> = {}
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      if (entry.isSymbolicLink()) throw new Error("Метаданные не должны содержать symlink")
      const name = prefix + entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path, name + "/")
      else if (/\.(ts|json|md)$/.test(name)) {
        const bytes = readFileSync(path)
        if (bytes.length > 131072) throw new Error("Источник метаданных превышает 128 KiB")
        sources[name] = bytes.toString("utf8")
      }
    }
  }
  visit(root)
  return "// Создано scripts/ai-metadata.ts из vendor/ai. Не редактировать вручную.\n"
    + "export const aiSources: Readonly<Record<string, string>> = Object.freeze("
    + JSON.stringify(sources, null, 2) + ")\n"
}

if (import.meta.main) {
  const rendered = renderAiMetadata()
  if (process.argv.includes("--check")) {
    if (readFileSync(destination, "utf8") !== rendered) throw new Error("Обновите метаданные: bun scripts/ai-metadata.ts")
  } else writeFileSync(destination, rendered)
  console.log("AI_METADATA_OK")
}
