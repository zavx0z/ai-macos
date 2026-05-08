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

export function logRequest(method: string, path: string, status: number, ms: number): void {
  const sc = scolor(status)
  console.log(`  ${mcolor(method)}${method.padEnd(7)}${R}${path.padEnd(30)}  ${sc}${status}${R}  ${DIM}${ms}ms${R}`)
}

export type Route = { method: string; path: string; description: string }
export type RouteGroup = { title?: string; routes: Route[] }

export function printBanner(name: string, port: number, groups: RouteGroup[]): void {
  console.log()
  console.log(`  ${BOLD}${CYAN}${name}${R}  ${DIM}·  http://localhost:${port}${R}`)
  console.log()
  for (const group of groups) {
    if (group.title) console.log(`  ${DIM}── ${group.title}${R}`)
    for (const { method, path, description } of group.routes) {
      console.log(`  ${mcolor(method)}${method.padEnd(7)}${R}${path.padEnd(34)}  ${DIM}${description}${R}`)
    }
    console.log()
  }
}
