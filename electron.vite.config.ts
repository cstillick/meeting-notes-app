import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
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
    plugins: [externalizeDepsPlugin()]
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
