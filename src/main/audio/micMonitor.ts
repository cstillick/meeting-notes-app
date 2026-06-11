// Lifecycle wrapper around the micmonitor helper: emits `activity` whenever
// some process starts/stops using the default microphone (meeting detection).
import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import type { Readable } from 'stream'
import { helperPath } from './helperPath'

export class MicMonitor extends EventEmitter<{ activity: [boolean] }> {
  private child: ChildProcessByStdio<null, Readable, null> | null = null
  private stopping = false

  start(): void {
    if (this.child) return
    this.stopping = false
    const child = spawn(helperPath('micmonitor'), [], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child

    // Without this, a spawn failure (missing/unsigned binary) raises an
    // unhandled 'error' event and takes down the whole main process.
    child.on('error', (err) => {
      console.error('[detect] micmonitor failed to start:', err.message)
    })

    let pending = ''
    child.stdout.on('data', (buf: Buffer) => {
      pending += buf.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { running?: boolean }
          if (typeof msg.running === 'boolean') this.emit('activity', msg.running)
        } catch {
          // ignore malformed lines
        }
      }
    })

    child.on('exit', (code) => {
      this.child = null
      if (!this.stopping) {
        console.warn(`[detect] micmonitor exited (code ${code}), restarting`)
        setTimeout(() => !this.stopping && this.start(), 1000)
      }
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
  }
}
