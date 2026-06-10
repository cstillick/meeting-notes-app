// Dev-only: Electron's stock Info.plist lacks NSAudioCaptureUsageDescription,
// so the macOS 14.4+ system-audio TCC prompt never appears for dev builds and
// the Core Audio tap silently records silence. Patch the dev Electron.app's
// plist and re-sign ad-hoc. Re-run after every Electron upgrade.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electronApp = join(root, 'node_modules/electron/dist/Electron.app')
const plist = join(electronApp, 'Contents/Info.plist')

if (!existsSync(plist)) {
  console.error('Electron.app not found — run npm install first')
  process.exit(1)
}

const entries = {
  NSAudioCaptureUsageDescription:
    'Granola Clone records system audio to transcribe your meetings.',
  NSMicrophoneUsageDescription:
    'Granola Clone uses the microphone to transcribe your side of meetings.'
}

let modified = false
for (const [key, value] of Object.entries(entries)) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'pipe' })
    console.log(`${key} already present`)
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist])
    console.log(`added ${key}`)
    modified = true
  }
}

if (modified) {
  // Finder/xattr detritus breaks codesign; strip it first
  execFileSync('xattr', ['-cr', electronApp], { stdio: 'pipe' })
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', electronApp], { stdio: 'pipe' })
  console.log('re-signed dev Electron.app (ad-hoc)')
} else {
  console.log('no changes — original signature left intact')
}
