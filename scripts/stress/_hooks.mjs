// Module customization hooks for running src/main code under plain Node:
// - alias `electron` to a stub (userData → $STRESS_USERDATA_DIR, throwing safeStorage)
// - resolve the app's extensionless relative imports (`./database`) by appending .ts
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./_electron-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.startsWith('@shared/')) {
    const rel = specifier.replace('@shared/', '../../src/shared/') + '.ts'
    return { url: new URL(rel, import.meta.url).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && !/\.[a-zA-Z]+$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {
      // fall through to default resolution
    }
  }
  return nextResolve(specifier, context)
}
