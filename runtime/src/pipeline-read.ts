import { z, type BrowserOperationResult } from "@meta/shared/contracts"
import { sha256 } from "./primitives.ts"

// Ограничен весь текст ответа, а не только один вызов браузера.
export const PIPELINE_READ_BUDGET = 65_536
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const offset = z.number().int().safe().min(0)
export const pipelineReadOptionsSchema = z.strictObject({
  url: z.string().min(1).max(4096),
  mode: z.enum(["dom", "accessibility", "resource"]).default("dom"),
  resourceUrl: z.string().min(1).max(4096).optional(),
  maxBytes: z.number().int().min(1).max(32_768).default(32_768),
  maxChunks: z.number().int().min(1).max(8).default(1),
  offsetBytes: offset.default(0),
  expectedSnapshotSha256: digest.optional(),
})
type ReadOptions = z.infer<typeof pipelineReadOptionsSchema>
type Cursor = Pick<ReadOptions, "offsetBytes" | "maxBytes" | "expectedSnapshotSha256">
const chunkSchema = z.strictObject({
  operationId: z.string().min(1).max(127), offsetBytes: offset, nextOffsetBytes: offset,
  contentBytes: offset, sha256: digest,
})
const resourceSchema = z.strictObject({
  url: z.string().min(1).max(4096), status: z.number().int().min(200).max(299),
  contentType: z.string().max(4096),
})
export const pipelineReadResultSchema = z.strictObject({
  stepId: z.string().min(1).max(40), targetId: z.string().min(1).max(127),
  url: z.string().max(4096), title: z.string().max(4096),
  mode: z.enum(["dom", "accessibility", "resource"]),
  content: z.string().max(PIPELINE_READ_BUDGET),
  contentBytes: z.number().int().min(0).max(PIPELINE_READ_BUDGET),
  sha256: digest, truncated: z.boolean(),
  offsetBytes: offset.optional(), nextOffsetBytes: offset.optional(), totalBytes: offset.optional(),
  snapshotSha256: digest.optional(), chunks: z.array(chunkSchema).min(1).max(8).optional(),
  resource: resourceSchema.optional(),
})

export function pipelineResourceUrl(step: ReadOptions): string {
  const page = new URL(step.url)
  const resource = new URL(step.resourceUrl!, page)
  if (!["http:", "https:"].includes(page.protocol) || resource.origin !== page.origin
    || resource.username || resource.password || resource.href.length > 4096) {
    throw new Error("Ресурс конвейера требует same-origin HTTP(S) URL без учётных данных")
  }
  return resource.href
}

// Эти проверки выполняются до первого шага, включая connect и согласие.
export function validatePipelineRead(step: ReadOptions, context: z.RefinementCtx): void {
  const invalid = (message: string) => context.addIssue({ code: "custom", message })
  if (step.offsetBytes > 0 && !step.expectedSnapshotSha256) invalid("Продолжение требует expectedSnapshotSha256")
  if (step.mode === "accessibility" && (step.maxChunks !== 1 || step.offsetBytes !== 0 || step.expectedSnapshotSha256 !== undefined)) {
    invalid("Accessibility не поддерживает продолжение байтового снимка")
  }
  if (step.mode === "resource") {
    if (!step.resourceUrl) invalid("Режим resource требует resourceUrl")
    else {
      try { pipelineResourceUrl(step) }
      catch (error) { invalid(error instanceof Error ? error.message : String(error)) }
    }
  } else if (step.resourceUrl !== undefined) invalid("resourceUrl допустим только в режиме resource")
}

/** Собирает один ограниченный диапазон одного снимка. Callback использует прежние Core-операции.
 * При любой ошибке накопленный текст этого шага не возвращается. Повтора чтения с нуля нет. */
export async function collectPipelineRead(
  step: ReadOptions,
  read: (cursor: Cursor, index: number) => Promise<{ value: BrowserOperationResult["value"], operationId: string }>,
) {
  const chunks: z.infer<typeof chunkSchema>[] = []
  let content = "", nextOffsetBytes = step.offsetBytes, truncated = true
  let snapshotSha256 = step.expectedSnapshotSha256
  let totalBytes: number | undefined
  let resource: z.infer<typeof resourceSchema> | undefined
  for (let index = 0; index < step.maxChunks; index++) {
    const { value, operationId } = await read({ offsetBytes: nextOffsetBytes, maxBytes: step.maxBytes,
      ...(snapshotSha256 === undefined ? {} : { expectedSnapshotSha256: snapshotSha256 }) }, index)
    if (value.kind !== "dom-read" && value.kind !== "resource-read") throw new Error("Ожидалась байтовая часть снимка")
    if ((step.mode === "resource") !== (value.kind === "resource-read")) throw new Error("Изменился режим чтения")
    // Геометрию байтов и соответствие запросу проверяет общий assertBrowserResultMatchesRequest.
    // Здесь проверяются неизменность всего набора частей и целостность полного результата.
    if (snapshotSha256 !== undefined && value.snapshotSha256 !== snapshotSha256) throw new Error("Изменился hash снимка между частями")
    if (totalBytes !== undefined && value.totalBytes !== totalBytes) throw new Error("Изменился totalBytes снимка между частями")
    snapshotSha256 = value.snapshotSha256
    totalBytes = value.totalBytes
    if (value.kind === "resource-read") {
      if (value.status < 200 || value.status >= 300) throw new Error(`HTTP ${value.status}: ресурс не прочитан успешно`)
      const actual = resourceSchema.parse({ url: value.url, status: value.status, contentType: value.contentType })
      if (actual.url !== pipelineResourceUrl(step)) throw new Error("Изменился URL читаемого ресурса")
      const mime = actual.contentType.split(";", 1)[0]!.trim().toLowerCase()
      if (!(mime.startsWith("text/") || ["application/json", "application/javascript", "application/xml"].includes(mime)
        || mime.endsWith("+json") || mime.endsWith("+xml"))) throw new Error("Ресурс не является текстовым HTTP-ответом")
      if (resource && (resource.status !== actual.status || resource.contentType !== actual.contentType)) {
        throw new Error("Изменились HTTP-метаданные между частями")
      }
      resource = actual
    }
    const text = value.kind === "dom-read" ? value.content : value.body
    const contentBytes = value.kind === "dom-read" ? value.contentBytes : value.bodyBytes
    chunks.push({ operationId, offsetBytes: value.offsetBytes, nextOffsetBytes: value.nextOffsetBytes,
      contentBytes, sha256: sha256(text) })
    content += text
    nextOffsetBytes = value.nextOffsetBytes
    truncated = value.truncated
    if (!truncated) break
  }
  const hash = sha256(content)
  if (step.offsetBytes === 0 && !truncated && hash !== snapshotSha256) {
    throw new Error("Полный текст не соответствует snapshotSha256")
  }
  return { content, contentBytes: Buffer.byteLength(content, "utf8"), sha256: hash,
    offsetBytes: step.offsetBytes, nextOffsetBytes, totalBytes: totalBytes!, snapshotSha256: snapshotSha256!,
    truncated, chunks, ...(resource ? { resource } : {}) }
}
