// Run every stress suite in scripts/stress with a throwaway userData dir and
// a real exit code. The suites print PASS/FAIL per check but always exit 0
// themselves, so this runner scans their output — `npm run stress` fails iff
// any check fails or a suite crashes.
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
  const failed = (res.stdout?.match(/^\s*FAIL\b/gm) ?? []).length
  if (res.status !== 0) {
    failures += 1
    console.error(`\n${suite}: CRASHED (exit ${res.status})\n${res.stderr}`)
  } else if (failed > 0) {
    failures += failed
  }
}

console.log(`\nstress: ${suites.length} suites, ${failures === 0 ? 'all checks PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
