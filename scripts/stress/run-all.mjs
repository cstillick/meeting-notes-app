// Run every stress suite in scripts/stress with a throwaway userData dir and
// a real exit code. Each suite prints PASS/FAIL per check and a machine-readable
// `SUMMARY pass=N fail=M` trailer (registered by _util.ts on process exit), so
// the verdict is the suite's own tally rather than a grep of its formatting.
// `npm run stress` fails iff a suite crashes, emits no trailer, asserts nothing,
// or reports a failed check.
import { spawnSync } from 'child_process'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort()

let failures = 0
let checks = 0
for (const suite of suites) {
  const res = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--import', join(dir, '_register.mjs'), join(dir, suite)],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        STRESS_USERDATA_DIR: mkdtempSync(join(tmpdir(), 'granola-stress-')),
        // keep the experimental-transform-types banner out of the output
        NODE_NO_WARNINGS: '1'
      }
    }
  )
  process.stdout.write(res.stdout ?? '')
  if (res.status !== 0) {
    failures += 1
    console.error(`\n${suite}: CRASHED (exit ${res.status})\n${res.stderr}`)
    continue
  }
  const trailer = (res.stdout ?? '').match(/^SUMMARY pass=(\d+) fail=(\d+)$/m)
  if (!trailer) {
    failures += 1
    console.error(`\n${suite}: no SUMMARY trailer — it must import result() from ./_util.ts`)
    continue
  }
  const [, passed, failed] = trailer.map(Number)
  checks += passed + failed
  if (passed + failed === 0) {
    failures += 1
    console.error(`\n${suite}: ran but asserted nothing (0 checks)`)
  } else {
    failures += failed
  }
}

console.log(
  `\nstress: ${suites.length} suites, ${checks} checks, ${failures === 0 ? 'all checks PASS' : `${failures} FAILURE(S)`}`
)
process.exit(failures === 0 ? 0 : 1)
