// Always-on diagnostic log for echo-suppression decisions, written to
// userData/echo-debug.log. Exists because the first real-world echo leak had
// to be diagnosed by inference from persisted segments: the packaged app
// can't be launched with ECHO_DEBUG=1 from Finder, so the measurements
// (coverage, time deltas, word confidence) were never captured. Volume is a
// few lines per minute of recording — cheap enough to keep on permanently.
import { appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const MAX_BYTES = 2_000_000
let logPath: string | null = null

/** Human-readable build identity; 'unbundled' under scripts/stress. */
export function buildStamp(): string {
  if (typeof __BUILD_INFO__ === 'undefined') return 'unbundled'
  return `${__BUILD_INFO__.commit} built ${__BUILD_INFO__.time}`
}

export function echoLog(line: string): void {
  try {
    if (!logPath) {
      logPath = join(app.getPath('userData'), 'echo-debug.log')
      try {
        // Single-slot rotation: keep at most one previous generation.
        if (statSync(logPath).size > MAX_BYTES) renameSync(logPath, `${logPath}.1`)
      } catch {
        // first run — no log yet
      }
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break recording
  }
}
