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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
