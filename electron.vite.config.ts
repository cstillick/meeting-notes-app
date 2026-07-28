import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// Baked into the main bundle so a running app can identify its build — a
// stale packaged .app once produced a convincing but bogus bug diagnosis.
function buildInfo(): string {
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: 'pipe' }).toString().trim()
  } catch {
    // not a git checkout (e.g. exported source) — time alone still identifies the build
  }
  return JSON.stringify({ time: new Date().toISOString(), commit })
}

// The detect panel is a real document loaded with loadFile (never a data: URL —
// that origin is opaque and carries no CSP). It ships next to its preload:
// electron-builder already includes out/preload/**, and the preload build is a
// bundler run, so the two static files need copying by hand.
const PANEL_ASSETS = ['detectPanel.html', 'detectPanelUi.js']

function copyPanelAssets(): Plugin {
  return {
    name: 'copy-detect-panel-assets',
    generateBundle() {
      for (const name of PANEL_ASSETS) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(resolve('src/preload', name), 'utf8')
        })
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_INFO__: buildInfo()
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), copyPanelAssets()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          detectPanel: resolve('src/preload/detectPanel.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
