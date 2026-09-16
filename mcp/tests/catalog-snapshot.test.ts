import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CatalogError, createCatalogSnapshot, loadCatalogSnapshot,
  assertRuntimeCompatible, assertToolAllowed,
} from '../src/catalog-snapshot.ts'

// Synthetic fixtures ONLY. These are not the real Mac catalog or its actual schemas.
function descriptor(name: string) {
  return {
    name,
    description: `Synthetic ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  }
}
const fixture = Array.from({ length: 36 }, (_, index) => descriptor(`fixture_${index}`))
const selectedNames = fixture.slice(0, 14).map(entry => entry.name)
const build = 'synthetic-test-build'
const make = () => createCatalogSnapshot(build, fixture, selectedNames)
const errorCode = (code: string) => (error: unknown) =>
  error instanceof CatalogError && error.code === code

function jsonCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

test('selects exactly the requested 14 of 36 descriptors', () => {
  const snapshot = make()
  assert.equal(snapshot.tools.length, 14)
  assert.deepEqual(snapshot.tools.map(entry => entry.name), [...selectedNames].sort())
  assert.equal(snapshot.runtimeBuildId, build)
  assert.match(snapshot.catalogHash, /^[0-9a-f]{64}$/)
})

test('compatible identity and catalog pass', () => {
  assert.doesNotThrow(() => assertRuntimeCompatible(make(), build, fixture))
})

test('actual descriptor fields are retained', () => {
  const entry = { ...descriptor('test'), outputSchema: { type: 'object' },
    _meta: { custom: ['one', 'two'] }, execution: { taskSupport: 'optional' } }
  const snapshot = createCatalogSnapshot(build, [entry], ['test'])
  assert.deepEqual(snapshot.tools[0], entry)
})

test('catalog ordering does not affect hash', () => {
  const other = createCatalogSnapshot(build, [...fixture].reverse(), [...selectedNames].reverse())
  assert.equal(make().catalogHash, other.catalogHash)
})

test('object-key ordering does not affect hash', () => {
  const reordered = fixture.map(entry => ({
    annotations: entry.annotations,
    inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    description: entry.description,
    name: entry.name,
  }))
  assert.doesNotThrow(() => assertRuntimeCompatible(make(), build, reordered))
})

test('unused tool changes or additions do not change selected hash', () => {
  const current = [...fixture.slice(0, 14), descriptor('unpublished_replacement')]
  assert.doesNotThrow(() => assertRuntimeCompatible(make(), build, current))
})

test('build mismatch fails even with identical schemas', () => {
  assert.throws(() => assertRuntimeCompatible(make(), 'other-build', fixture), errorCode('BUILD_MISMATCH'))
})

test('build mismatch is rejected before catalog decoding', () => {
  assert.throws(() => assertRuntimeCompatible(make(), 'other-build', null), errorCode('BUILD_MISMATCH'))
})

const changedFields: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['input schema', { inputSchema: { type: 'object', required: ['newField'] } }],
  ['output schema', { outputSchema: { type: 'object', required: ['newField'] } }],
  ['annotations', { annotations: { readOnlyHint: false } }],
  ['description', { description: 'Changed descriptor' }],
  ['metadata', { _meta: { behavior: 'changed' } }],
]
for (const [label, patch] of changedFields) {
  test(`${label} change fails closed`, () => {
    const current = fixture.map((entry, i) => i === 0 ? { ...entry, ...patch } : entry)
    assert.throws(() => assertRuntimeCompatible(make(), build, current), errorCode('CATALOG_MISMATCH'))
  })
}

test('array ordering inside a descriptor remains significant', () => {
  const a = { ...descriptor('test'), _meta: { order: ['a', 'b'] } }
  const b = { ...descriptor('test'), _meta: { order: ['b', 'a'] } }
  const snapshot = createCatalogSnapshot(build, [a], ['test'])
  assert.throws(() => assertRuntimeCompatible(snapshot, build, [b]), errorCode('CATALOG_MISMATCH'))
})

test('missing selected tool is rejected', () => {
  assert.throws(() => assertRuntimeCompatible(make(), build, fixture.slice(1)), errorCode('INVALID_CATALOG'))
})

test('duplicate catalog entries are rejected', () => {
  assert.throws(() => createCatalogSnapshot(build, [...fixture, fixture[0]], selectedNames), errorCode('INVALID_CATALOG'))
})

test('duplicate selected names are rejected', () => {
  assert.throws(() => createCatalogSnapshot(build, fixture, ['fixture_0', 'fixture_0']), errorCode('INVALID_CATALOG'))
})

test('empty selection is rejected', () => {
  assert.throws(() => createCatalogSnapshot(build, fixture, []), errorCode('INVALID_CATALOG'))
})

test('unknown selected name is rejected', () => {
  assert.throws(() => createCatalogSnapshot(build, fixture, ['not_a_tool']), errorCode('INVALID_CATALOG'))
})

test('missing build is rejected', () => {
  assert.throws(() => createCatalogSnapshot('', fixture, selectedNames), errorCode('INVALID_SNAPSHOT'))
})

test('invalid input schema is rejected', () => {
  const entry = { name: 'invalid', inputSchema: { type: 'string' } }
  assert.throws(() => createCatalogSnapshot(build, [entry], ['invalid']), errorCode('INVALID_CATALOG'))
})

const nonJsonValues: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity], ['BigInt', 1n],
  ['function', () => 1], ['Date', new Date(0)], ['Symbol', Symbol('invalid')],
]
for (const [label, invalid] of nonJsonValues) {
  test(`non-JSON ${label} is rejected, not silently dropped`, () => {
    const entry = { ...descriptor('test'), _meta: { invalid } }
    assert.throws(() => createCatalogSnapshot(build, [entry], ['test']), errorCode('INVALID_CATALOG'))
  })
}

test('cycles are rejected', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const entry = { ...descriptor('test'), _meta: cycle }
  assert.throws(() => createCatalogSnapshot(build, [entry], ['test']), errorCode('INVALID_CATALOG'))
})

test('repeated acyclic references are accepted', () => {
  const shared = { value: true }
  const entry = { ...descriptor('test'), _meta: { a: shared, b: shared } }
  assert.doesNotThrow(() => createCatalogSnapshot(build, [entry], ['test']))
})

test('sparse arrays are rejected as undefined, not hashed ambiguously', () => {
  const entry = { ...descriptor('test'), _meta: { array: new Array(2) } }
  assert.throws(() => createCatalogSnapshot(build, [entry], ['test']), errorCode('INVALID_CATALOG'))
})

test('symbol keys are rejected', () => {
  const entry = { ...descriptor('test'), [Symbol('not-json')]: 'value' }
  assert.throws(() => createCatalogSnapshot(build, [entry], ['test']), errorCode('INVALID_CATALOG'))
})

test('snapshots do not retain mutable source objects', () => {
  const entry = descriptor('test')
  const snapshot = createCatalogSnapshot(build, [entry], ['test'])
  entry.inputSchema.additionalProperties = true
  entry.annotations.readOnlyHint = false
  assert.equal(snapshot.tools[0]?.inputSchema.additionalProperties, false)
  assert.deepEqual(snapshot.tools[0]?.annotations, { readOnlyHint: true })
})

test('snapshot and nested descriptors are frozen', () => {
  const snapshot = make()
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.tools))
  assert.ok(Object.isFrozen(snapshot.tools[0]))
  assert.ok(Object.isFrozen(snapshot.tools[0]?.inputSchema))
})

test('serialized artifact round-trips', () => {
  const original = make()
  const loaded = loadCatalogSnapshot(jsonCopy(original))
  assert.deepEqual(loaded, original)
  assert.doesNotThrow(() => assertRuntimeCompatible(loaded, build, fixture))
})

test('corrupted hash is rejected', () => {
  assert.throws(() => loadCatalogSnapshot({ ...make(), catalogHash: '0'.repeat(64) }), errorCode('INVALID_SNAPSHOT'))
})

test('modified descriptor is rejected during load', () => {
  const snapshot = make()
  const tools = snapshot.tools.map((entry, index) => index ? entry : { ...entry, description: 'tampered' })
  assert.throws(() => loadCatalogSnapshot({ ...snapshot, tools }), errorCode('INVALID_SNAPSHOT'))
})

for (const invalid of [null, [], {}, { ...make(), format: 'unknown' }, { ...make(), catalogHash: 'bad' }]) {
  test(`invalid artifact envelope ${JSON.stringify(invalid).slice(0, 45)} is rejected`, () => {
    assert.throws(() => loadCatalogSnapshot(invalid), errorCode('INVALID_SNAPSHOT'))
  })
}

test('selected calls are permitted by the local allowlist', () => {
  assert.doesNotThrow(() => assertToolAllowed(make(), 'fixture_0'))
})

test('runtime-only tools cannot bypass the published allowlist', () => {
  assert.throws(() => assertToolAllowed(make(), 'fixture_35'), errorCode('TOOL_NOT_ALLOWED'))
})

test('object prototype property names are not treated as allowed tools', () => {
  assert.throws(() => assertToolAllowed(make(), '__proto__'), errorCode('TOOL_NOT_ALLOWED'))
  assert.throws(() => assertToolAllowed(make(), 'constructor'), errorCode('TOOL_NOT_ALLOWED'))
})
