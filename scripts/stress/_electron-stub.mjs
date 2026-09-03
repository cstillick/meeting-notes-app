// Electron stub for stress scripts. Hard safety rail: refuses to run without an
// explicit sandbox dir, and refuses any path inside the real userData tree.
const dir = process.env.STRESS_USERDATA_DIR
if (!dir) {
  throw new Error('STRESS_USERDATA_DIR is not set — refusing to run stress scripts')
}
if (dir.includes('Application Support')) {
  throw new Error(`STRESS_USERDATA_DIR points inside Application Support (${dir}) — refusing`)
}

export const app = {
  getPath(name) {
    if (name !== 'userData') throw new Error(`electron stub: unsupported path "${name}"`)
    return dir
  }
}

// Test-only stand-in for the OS keychain. NOT encryption — a reversible
// encoding, so a suite can put a fake API key in the sandbox's settings.json
// and exercise code paths gated on "is a key set" (Recorder.start picks its
// sessions only after that check). The real safety rail is the path guard
// above: this can only ever reach the sandbox dir, never the user's keychain
// and never their settings.json.
export const safeStorage = {
  isEncryptionAvailable() {
    return true
  },
  encryptString(plain) {
    return Buffer.from(`stress:${plain}`, 'utf8')
  },
  decryptString(buf) {
    const s = Buffer.from(buf).toString('utf8')
    if (!s.startsWith('stress:')) throw new Error('stress safeStorage: not a stub-encoded value')
    return s.slice('stress:'.length)
  }
}

export default { app, safeStorage }
