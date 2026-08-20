// Package src/mcp as a Claude Desktop extension (.mcpb).
//
// Claude Desktop rewrites claude_desktop_config.json from its own settings
// state, so a hand-added `mcpServers` entry does not survive a launch. The
// supported route on this build is an extension bundle, which Desktop installs
// into its own store and manages itself.
//
// A .mcpb is a zip with manifest.json at the ARCHIVE ROOT. Desktop runs the
// entry point with its built-in Node (Electron 42 → Node 24.16, which has
// node:sqlite with FTS5), so the bundle ships compiled JS and vendored deps and
// assumes nothing about the user's own node install.
//
// Run: npm run build:mcpb
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'build', 'mcpb')
const outDir = join(root, 'dist')
const outFile = join(outDir, 'notetaker.mcpb')

const pkg = JSON.parse(
  await import('node:fs').then((fs) => fs.readFileSync(join(root, 'package.json'), 'utf8'))
)
/** The bundle vendors these; they are devDependencies in the app so they never
 *  ship inside the packaged .app, which does not use them. */
const SDK = pkg.devDependencies['@modelcontextprotocol/sdk']
const ZOD = pkg.devDependencies['zod']

function step(msg) {
  console.log(`\n▸ ${msg}`)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${res.status})`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------

step('Cleaning')
rmSync(bundle, { recursive: true, force: true })
mkdirSync(bundle, { recursive: true })
mkdirSync(outDir, { recursive: true })
rmSync(outFile, { force: true })

step('Compiling TypeScript → dist/')
run('npx', ['tsc', '-p', 'tsconfig.mcpb.json'])

step('Writing bundle package.json')
writeFileSync(
  join(bundle, 'package.json'),
  `${JSON.stringify(
    {
      name: 'notetaker-mcpb',
      version: pkg.version,
      private: true,
      // The emitted code is ESM; without this Node would parse it as CommonJS.
      type: 'module',
      dependencies: { '@modelcontextprotocol/sdk': SDK, zod: ZOD }
    },
    null,
    2
  )}\n`
)

step('Installing production dependencies into the bundle')
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: bundle })

step('Introspecting the built server for its real tool list')
const tools = await listTools(join(bundle, 'dist', 'mcp', 'server.js'))
console.log(`  ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`)

step('Writing manifest.json')
writeFileSync(
  join(bundle, 'manifest.json'),
  `${JSON.stringify(
    {
      manifest_version: '0.3',
      name: 'notetaker',
      display_name: 'Notetaker',
      version: pkg.version,
      description:
        'Search and read your Notetaker library — meeting and lecture notes, AI-enhanced notes, and full speaker-labelled transcripts. Read-only.',
      long_description:
        'Exposes the local Notetaker library (SQLite) to Claude as retrieval tools: ranked full-text search over notes and transcripts, exact spoken-word search with timestamps, and paged transcript access. The database is opened read-only and every query is a SELECT, so nothing here can modify or delete a note. Runs entirely on this Mac; no network access.',
      author: { name: pkg.author },
      license: 'MIT',
      icon: 'icon.png',
      keywords: ['meetings', 'notes', 'lectures', 'transcripts', 'search'],
      // Derived from the server's own tools/list above, so the manifest can
      // never drift from what the server actually advertises.
      tools,
      server: {
        type: 'node',
        entry_point: 'dist/mcp/server.js',
        mcp_config: {
          command: 'node',
          args: ['${__dirname}/dist/mcp/server.js'],
          env: {}
        }
      }
    },
    null,
    2
  )}\n`
)

step('Validating the manifest against the official mcpb schema')
validateManifest()

step('Adding icon')
const logo = join(root, 'Ledger-logo.png')
if (existsSync(logo)) copyFileSync(logo, join(bundle, 'icon.png'))
else console.log('  (no Ledger-logo.png — skipping)')

step('Packing .mcpb (zip, manifest.json at archive root)')
run('zip', ['-r', '-q', '-X', outFile, '.', '-x', '.*'], { cwd: bundle })

const mb = (statSync(outFile).size / 1_048_576).toFixed(1)
console.log(`\n✓ ${outFile} (${mb} MB)`)
console.log('\nInstall: Claude Desktop → Settings → Extensions → Advanced settings →')
console.log('         Install extension… → choose the .mcpb above (or drag it onto the window).')

// ---------------------------------------------------------------------------

/** Check manifest.json against the published schema. The v0.3 schema is strict
 *  (`additionalProperties: false`), so a stray field is a hard install failure
 *  with no useful message in the UI — much better to catch it here.
 *
 *  Needs the network for npx. A validator that cannot run is a warning; a
 *  validator that runs and rejects is fatal. */
function validateManifest() {
  const res = spawnSync('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'validate', join(bundle, 'manifest.json')], {
    cwd: root,
    encoding: 'utf8'
  })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (/validation passes/i.test(output)) {
    console.log('  schema validation passes')
    return
  }
  if (res.status !== 0 && /^(?:(?!validat).)*$/is.test(output.slice(0, 200))) {
    console.log(`  ⚠ could not run the validator (offline?) — skipping:\n${output.trim().slice(0, 300)}`)
    return
  }
  console.error(`\nmanifest failed schema validation:\n${output}`)
  process.exit(1)
}

/** Start the built server over stdio and ask it what it exposes. Doubles as a
 *  build-time smoke test: a bundle whose entry point cannot start fails here
 *  rather than silently installing and showing no tools. */
function listTools(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A throwaway path: introspection must not depend on the user having a
      // library yet, and must never touch the real one.
      env: { ...process.env, GRANOLA_DB_PATH: join(bundle, '.introspect-none.db') }
    })
    let stderr = ''
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not respond in 20s.\n${stderr}`))
    }, 20_000)

    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          clearTimeout(timer)
          child.kill()
          reject(new Error(`non-JSON on stdout, which would corrupt the transport: ${line}`))
          return
        }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
        } else if (msg.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve(
            msg.result.tools.map((t) => ({
              name: t.name,
              description: t.description
            }))
          )
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'build-mcpb', version: '1.0.0' }
        }
      })}\n`
    )
  })
}
