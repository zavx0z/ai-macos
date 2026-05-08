const R = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'

const METHOD_COLOR: Record<string, string> = {
  GET:    '\x1b[34m',
  POST:   '\x1b[32m',
  DELETE: '\x1b[31m',
  PUT:    '\x1b[33m',
  PATCH:  '\x1b[35m',
}

function mcolor(method: string): string { return METHOD_COLOR[method] ?? '\x1b[33m' }
function scolor(status: number): string {
  if (status < 300) return '\x1b[32m'
  if (status < 400) return '\x1b[33m'
  return '\x1b[31m'
}
function abbrev(method: string): string { return method === 'DELETE' ? 'DEL' : method }

export function logRequest(method: string, path: string, status: number, ms: number): void {
  const m = abbrev(method)
  const sc = scolor(status)
  console.log(`  ${mcolor(method)}${m.padEnd(4)}${R}  ${path.padEnd(26)}  ${sc}${status}${R}  ${DIM}${ms}ms${R}`)
}

export type Route = { method: string; path: string; description: string }
export type RouteGroup = { title?: string; routes: Route[] }

export function printBanner(name: string, port: number, groups: RouteGroup[]): void {
  const all = groups.flatMap(g => g.routes)
  const c1 = Math.max(...all.map(r => abbrev(r.method).length))
  const c2 = Math.max(...all.map(r => r.path.length))
  const c3 = Math.max(...all.map(r => r.description.length))
  const gw = c1 + c2 + c3 + 6

  const h = '─'
  const top = `┌${h.repeat(c1+2)}┬${h.repeat(c2+2)}┬${h.repeat(c3+2)}┐`
  const sep = `├${h.repeat(c1+2)}┼${h.repeat(c2+2)}┼${h.repeat(c3+2)}┤`
  const bot = `└${h.repeat(c1+2)}┴${h.repeat(c2+2)}┴${h.repeat(c3+2)}┘`
  const gt  = `├${h.repeat(c1+2)}┴${h.repeat(c2+2)}┴${h.repeat(c3+2)}┤`
  const gb  = `├${h.repeat(c1+2)}┬${h.repeat(c2+2)}┬${h.repeat(c3+2)}┤`

  const row = (r: Route) =>
    `│ ${mcolor(r.method)}${abbrev(r.method).padEnd(c1)}${R} │ ${r.path.padEnd(c2)} │ ${DIM}${r.description.padEnd(c3)}${R} │`

  console.log(`  ${BOLD}${CYAN}${name}${R}  ${DIM}http://localhost:${port}${R}`)
  console.log(top)
  let first = true
  for (const group of groups) {
    if (!first) {
      if (group.title) {
        console.log(gt)
        console.log(`│ ${DIM}${group.title.padEnd(gw)}${R} │`)
        console.log(gb)
      } else {
        console.log(sep)
      }
    }
    first = false
    for (const r of group.routes) console.log(row(r))
  }
  console.log(bot)
}
