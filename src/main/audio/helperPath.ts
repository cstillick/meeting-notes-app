import { app } from 'electron'
import { join } from 'path'

/** Resolve a vendored helper binary, in dev (project resources/) and packaged (extraResources). */
export function helperPath(name: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', name)
  }
  return join(app.getAppPath(), 'resources', 'bin', name)
}
