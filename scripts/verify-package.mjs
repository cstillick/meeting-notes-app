// Post-package guard: fail the build unless every file electron-vite just
// produced under out/ is byte-identical to its counterpart inside the .app's
// asar, in both directions. Exists because a stale dist/ app was once tested as
// if freshly built, producing a convincing but bogus root-cause analysis of an
// echo-suppression "bug" that was already fixed — and a stale renderer bundle
// ships its own matching index.html, so it boots happily with old UI.
// Runs as the last step of `npm run build`.
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, sep } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

// Mirrors the `files` globs in electron-builder.yml.
const ROOTS = ['out/main', 'out/preload', 'out/renderer']

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

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(p))
    else if (entry.isFile()) files.push(p.split(sep).join('/'))
  }
  return files
}

/** Flatten the asar header tree into archive-relative file paths. */
function packedFiles(node, prefix) {
  const files = []
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) files.push(...packedFiles(entry, p))
    else files.push(p)
  }
  return files
}

const asarPath = findAsar()

const local = ROOTS.flatMap((root) => {
  if (!existsSync(root)) fail(`${root} does not exist — did electron-vite build run?`)
  return walk(root)
})

for (const file of local) {
  let packed
  try {
    packed = asar.extractFile(asarPath, file)
  } catch {
    fail(`${file} missing from ${asarPath}`)
  }
  if (!packed.equals(readFileSync(file))) {
    fail(
      `${file} in ${asarPath} differs from the local build output — ` +
        'the packaged app is stale; re-run npm run build'
    )
  }
}

// Reverse direction: an asar entry the current build no longer produces is a
// leftover from an older one — the case a hash-named bundle hides, since the
// stale file and its stale index.html agree with each other.
const built = new Set(local)
const orphans = packedFiles(asar.getRawHeader(asarPath).header, '')
  .filter((p) => ROOTS.some((root) => p.startsWith(`${root}/`)))
  .filter((p) => !built.has(p))
if (orphans.length > 0) {
  fail(
    `${asarPath} carries ${orphans.length} file(s) that out/ no longer contains — ` +
      `the packaged app is stale; re-run npm run build:\n  ${orphans.join('\n  ')}`
  )
}

const mtime = statSync(asarPath).mtime.toISOString()
console.log(
  `verify-package: OK — ${asarPath} matches out/ (${local.length} files, asar mtime ${mtime})`
)
