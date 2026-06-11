// Post-package guard: fail the build if the .app's asar doesn't contain the
// bundles electron-vite just produced. Exists because a stale dist/ app was
// once tested as if freshly built, producing a convincing but bogus
// root-cause analysis of an echo-suppression "bug" that was already fixed.
// Runs as the last step of `npm run build`.
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

function findAsar() {
  if (!existsSync('dist')) fail('dist/ does not exist — did electron-builder run?')
  for (const dir of readdirSync('dist', { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const entry of readdirSync(join('dist', dir.name))) {
      if (!entry.endsWith('.app')) continue
      const p = join('dist', dir.name, entry, 'Contents/Resources/app.asar')
      if (existsSync(p)) return p
    }
  }
  fail('no app.asar found under dist/*/*.app')
}

function fail(msg) {
  console.error(`verify-package: FAIL — ${msg}`)
  process.exit(1)
}

const asarPath = findAsar()
const bundles = ['out/main/index.js', 'out/preload/index.js']
for (const bundle of bundles) {
  let packed
  try {
    packed = asar.extractFile(asarPath, bundle)
  } catch {
    fail(`${bundle} missing from ${asarPath}`)
  }
  if (!packed.equals(readFileSync(bundle))) {
    fail(
      `${bundle} in ${asarPath} differs from the local build output — ` +
        'the packaged app is stale; re-run npm run build'
    )
  }
}
const mtime = statSync(asarPath).mtime.toISOString()
console.log(`verify-package: OK — ${asarPath} matches out/ (asar mtime ${mtime})`)
