// Lifecycle wrapper around the audiotee helper (Core Audio process tap).
// Emits raw 16 kHz s16le mono PCM chunks from system audio output.
// PCM rides raw on stdout; JSON log lines ride on stderr.
import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import type { Readable } from 'stream'
import { helperPath } from './helperPath'

const SILENCE_RESTART_MS = 5000
const MAX_RESTARTS = 5

export interface AudioTeeEvents {
  chunk: [Buffer]
  status: [string]
  exit: [{ code: number | null; expected: boolean }]
}

export class AudioTee extends EventEmitter<AudioTeeEvents> {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private stopping = false
  private restarts = 0
  private lastChunkAt = 0
  private silenceTimer: NodeJS.Timeout | null = null
  private nonZeroSeen = false
  private zeroRunStartedAt = 0
  private warnedAllZero = false

  start(): void {
    this.stopping = false
    this.restarts = 0
    this.nonZeroSeen = false
    this.zeroRunStartedAt = 0
    this.warnedAllZero = false
    this.spawnChild()
  }

  private spawnChild(): void {
    if (this.child) return
    const child = spawn(helperPath('audiotee'), ['--sample-rate', '16000', '--chunk-duration', '0.1'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.lastChunkAt = Date.now()

    // Without this, a spawn failure (missing/unsigned binary) raises an
    // unhandled 'error' event and takes down the whole main process.
    child.on('error', (err) => {
      this.child = null
      this.clearSilenceTimer()
      this.emit('status', `system audio helper failed to start: ${err.message}`)
    })

    child.stdout.on('data', (buf: Buffer) => {
      this.lastChunkAt = Date.now()
      this.checkForSilentTap(buf)
      this.emit('chunk', buf)
    })

    child.stderr.on('data', (buf: Buffer) => {
      // JSON log lines; surface errors only
      for (const line of buf.toString().split('\n')) {
        if (line.includes('"error"')) this.emit('status', line.trim())
      }
    })

    child.on('exit', (code) => {
      this.child = null
      this.clearSilenceTimer()
      const expected = this.stopping
      this.emit('exit', { code, expected })
      if (!expected && this.restarts < MAX_RESTARTS) {
        this.restarts += 1
        this.emit('status', `audiotee exited unexpectedly (code ${code}), restarting`)
        setTimeout(() => !this.stopping && this.spawnChild(), 250 * this.restarts)
      }
    })

    // Output-device switches (AirPods connecting) can wedge the tap: restart
    // if the helper goes quiet while it's supposed to be streaming.
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastChunkAt > SILENCE_RESTART_MS && this.child) {
        this.emit('status', 'audiotee silent >5s, restarting tap')
        this.restartChild()
      }
    }, 1000)
  }

  /** A tap without the System Audio Recording permission "works" but delivers
   *  pure digital silence — surface that, since the OS gives no error at all. */
  private checkForSilentTap(buf: Buffer): void {
    if (this.nonZeroSeen || this.warnedAllZero) return
    if (buf.some((b) => b !== 0)) {
      this.nonZeroSeen = true
      return
    }
    if (this.zeroRunStartedAt === 0) this.zeroRunStartedAt = Date.now()
    if (Date.now() - this.zeroRunStartedAt > 10_000) {
      this.warnedAllZero = true
      this.emit(
        'status',
        'No system audio captured yet — if you expect to hear others, check ' +
          'System Settings → Privacy & Security → Screen & System Audio Recording'
      )
    }
  }

  private restartChild(): void {
    const child = this.child
    this.child = null
    this.clearSilenceTimer()
    child?.kill()
    if (!this.stopping) this.spawnChild()
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  stop(): void {
    this.stopping = true
    this.clearSilenceTimer()
    this.child?.kill()
    this.child = null
  }

  get running(): boolean {
    return this.child !== null
  }
}
