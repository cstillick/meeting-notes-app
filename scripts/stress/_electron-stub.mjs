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

export const safeStorage = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`safeStorage.${String(prop)} is not available outside Electron`)
    }
  }
)

export default { app, safeStorage }
