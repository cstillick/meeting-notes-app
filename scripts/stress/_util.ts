import { writeSync } from 'node:fs'

let passes = 0
let failures = 0
let summarized = false

export function time<T>(label: string, fn: () => T): T {
  const t0 = process.hrtime.bigint()
  const out = fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`  [time] ${label}: ${ms.toFixed(1)} ms`)
  return out
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===`)
}

export function result(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Machine-readable verdict run-all.mjs parses; a suite without one fails.
 *  writeSync, not console.log: stdout is an async pipe on macOS, so writes
 *  issued from an exit handler can be dropped. */
export function summary(): void {
  if (summarized) return
  summarized = true
  writeSync(1, `SUMMARY pass=${passes} fail=${failures}\n`)
}

process.on('exit', summary)
