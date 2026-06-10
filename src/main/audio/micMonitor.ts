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

    child.on('exit', () => {
      this.child = null
      if (!this.stopping) {
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
