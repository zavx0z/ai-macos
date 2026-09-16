import { createHash } from 'node:crypto'

/** Проверяет snapshot без транспорта, polling, admission, повторов и запуска Native. */
export interface ToolDescriptor {
  readonly name: string
  readonly inputSchema: {
    readonly type: 'object'
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface CatalogSnapshot {
  readonly format: 'ai-macos.catalog-snapshot.v1'
  readonly runtimeBuildId: string
  /** SHA-256 всех полей выбранных описаний инструментов. */
  readonly catalogHash: string
  readonly tools: readonly ToolDescriptor[]
}

export type CatalogErrorCode =
  | 'INVALID_CATALOG' | 'INVALID_SNAPSHOT' | 'BUILD_MISMATCH'
  | 'CATALOG_MISMATCH' | 'TOOL_NOT_ALLOWED'

export class CatalogError extends Error {
  readonly code: CatalogErrorCode
  constructor(code: CatalogErrorCode, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function tool(value: unknown): value is ToolDescriptor {
  return record(value) && typeof value.name === 'string' && value.name.trim() !== ''
    && record(value.inputSchema) && value.inputSchema.type === 'object'
}

// Детерминированный JSON: порядок ключей и инструментов незначим,
// порядок массивов внутри описания сохраняется. Это не реализация RFC 8785.
function encode(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new CatalogError('INVALID_CATALOG', 'Catalog must contain acyclic JSON values.')
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new CatalogError('INVALID_CATALOG', 'Catalog must contain plain JSON objects.')
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new CatalogError('INVALID_CATALOG', 'Symbol keys are not JSON.')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return '[' + Array.from(value, item => encode(item, ancestors)).join(',') + ']'
    }
    if (!record(value)) throw new CatalogError('INVALID_CATALOG', 'Invalid JSON object.')
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + encode(value[key], ancestors)).join(',') + '}'
  } finally {
    ancestors.delete(value)
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function select(catalog: unknown, names: readonly string[]): ToolDescriptor[] {
  if (!Array.isArray(catalog) || !Array.isArray(names) || names.length === 0
      || names.some(name => typeof name !== 'string' || name.trim() === '')
      || new Set(names).size !== names.length) {
    throw new CatalogError('INVALID_CATALOG', 'Expected a catalog and nonempty unique tool names.')
  }
  const byName = new Map<string, unknown>()
  for (const entry of catalog) {
    if (!record(entry) || typeof entry.name !== 'string' || entry.name.trim() === ''
        || byName.has(entry.name)) {
      throw new CatalogError('INVALID_CATALOG', 'Catalog has an invalid or duplicate tool name.')
    }
    byName.set(entry.name, entry)
  }
  return [...names].sort().map(name => {
    const value = byName.get(name)
    if (!tool(value)) {
      throw new CatalogError('INVALID_CATALOG', `Missing or invalid selected tool: ${name}`)
    }
    // Копия wire JSON сохраняет все поля без общих изменяемых объектов.
    const copy: unknown = JSON.parse(encode(value))
    if (!tool(copy)) throw new CatalogError('INVALID_CATALOG', `Invalid copied tool: ${name}`)
    return freeze(copy)
  })
}

function hash(tools: readonly ToolDescriptor[]): string {
  return createHash('sha256').update(encode(tools)).digest('hex')
}

/** Создаёт snapshot из фактической сборки Runtime и её настоящего каталога. */
export function createCatalogSnapshot(
  runtimeBuildId: string,
  catalog: unknown,
  selectedNames: readonly string[],
): CatalogSnapshot {
  if (typeof runtimeBuildId !== 'string' || runtimeBuildId.trim() === '') {
    throw new CatalogError('INVALID_SNAPSHOT', 'A nonempty Runtime build ID is required.')
  }
  const tools = select(catalog, selectedNames)
  return freeze({
    format: 'ai-macos.catalog-snapshot.v1',
    runtimeBuildId,
    catalogHash: hash(tools),
    tools,
  })
}

/** Проверяет артефакт при запуске прокси без скрытого пересоздания snapshot. */
export function loadCatalogSnapshot(value: unknown): CatalogSnapshot {
  if (!record(value) || value.format !== 'ai-macos.catalog-snapshot.v1'
      || typeof value.runtimeBuildId !== 'string' || typeof value.catalogHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.catalogHash) || !Array.isArray(value.tools)) {
    throw new CatalogError('INVALID_SNAPSHOT', 'Invalid catalog snapshot envelope.')
  }
  const names = value.tools.map(entry => {
    if (!tool(entry)) throw new CatalogError('INVALID_SNAPSHOT', 'Invalid snapshot tool.')
    return entry.name
  })
  const snapshot = createCatalogSnapshot(value.runtimeBuildId, value.tools, names)
  if (snapshot.catalogHash !== value.catalogHash) {
    throw new CatalogError('INVALID_SNAPSHOT', 'Snapshot descriptors do not match their hash.')
  }
  return snapshot
}

/** Проверяет новое соединение по свежим identity и каталогу этого Runtime. */
export function assertRuntimeCompatible(
  snapshot: CatalogSnapshot,
  runtimeBuildId: string,
  runtimeCatalog: unknown,
): void {
  if (runtimeBuildId !== snapshot.runtimeBuildId) {
    throw new CatalogError('BUILD_MISMATCH',
      `Runtime build mismatch: expected ${snapshot.runtimeBuildId}, received ${runtimeBuildId}.`)
  }
  const current = select(runtimeCatalog, snapshot.tools.map(entry => entry.name))
  const actualHash = hash(current)
  if (actualHash !== snapshot.catalogHash) {
    throw new CatalogError('CATALOG_MISMATCH',
      `Selected catalog mismatch: expected ${snapshot.catalogHash}, received ${actualHash}.`)
  }
}

/** Запрещает имена операций вне опубликованного snapshot. */
export function assertToolAllowed(snapshot: CatalogSnapshot, name: string): void {
  if (!snapshot.tools.some(entry => entry.name === name)) {
    throw new CatalogError('TOOL_NOT_ALLOWED', `Tool is not in the published snapshot: ${name}`)
  }
}
