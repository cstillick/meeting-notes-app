// Lifecycle wrapper around the audiotee helper (Core Audio process tap).
// Emits raw 16 kHz s16le mono PCM chunks from system audio output.
// PCM rides raw on stdout; JSON log lines ride on stderr.
import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import type { Readable } from 'stream'
import { helperPath } from './helperPath'

const SILENCE_RESTART_MS = 5000
const MAX_RESTARTS = 5
const SIGKILL_AFTER_MS = 2000
const GAVE_UP = 'system audio capture stopped — restart the recording to get it back'

type Helper = ChildProcessByStdio<null, Readable, Readable>

export interface AudioTeeEvents {
  chunk: [Buffer]
  status: [string]
  /** The live helper died. Helpers retired by a restart are silent (their
   *  successor is already running); `terminal` means the restart budget is
   *  spent, so no respawn is pending and system audio is gone for this session. */
  exit: [{ code: number | null; expected: boolean; terminal: boolean }]
}

export class AudioTee extends EventEmitter<AudioTeeEvents> {
  private child: Helper | null = null
  /** Every helper spawned but not yet reaped. A retired child stays here until
   *  its exit lands so stop() can drain it: an orphaned Core Audio tap outlives
   *  the meeting and keeps the macOS recording indicator lit. */
  private live = new Set<Helper>()
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
    this.live.add(child)
    this.lastChunkAt = Date.now()

    // Every handler below is identity-guarded on `child`: a replacement is
    // spawned synchronously in restartChild(), so a retired helper's events
    // always arrive after its successor is installed and would otherwise drop
    // the new reference, kill the new watchdog, and trigger a third spawn.

    // Without this, a spawn failure (missing/unsigned binary) raises an
    // unhandled 'error' event and takes down the whole main process.
    child.on('error', (err) => {
      this.live.delete(child)
      if (this.child !== child) return
      this.child = null
      this.clearSilenceTimer()
      this.emit('status', `system audio helper failed to start: ${err.message}`)
    })

    child.stdout.on('data', (buf: Buffer) => {
      if (this.child !== child) return
      this.lastChunkAt = Date.now()
      this.checkForSilentTap(buf)
      this.emit('chunk', buf)
    })

    child.stderr.on('data', (buf: Buffer) => {
      if (this.child !== child) return
      // JSON log lines; surface errors only
      for (const line of buf.toString().split('\n')) {
        if (line.includes('"error"')) this.emit('status', line.trim())
      }
    })

    child.on('exit', (code) => {
      this.live.delete(child)
      if (this.stopping) {
        this.emit('exit', { code, expected: true, terminal: false })
        return
      }
      if (this.child !== child) return
      this.child = null
      this.clearSilenceTimer()
      const terminal = this.restarts >= MAX_RESTARTS
      this.emit('exit', { code, expected: false, terminal })
      if (terminal) {
        this.emit('status', GAVE_UP)
        return
      }
      this.restarts += 1
      this.emit('status', `audiotee exited unexpectedly (code ${code}), restarting`)
      setTimeout(() => !this.stopping && this.spawnChild(), 250 * this.restarts)
    })

    // Output-device switches (AirPods connecting) can wedge the tap: restart
    // if the helper goes quiet while it's supposed to be streaming.
    this.clearSilenceTimer()
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastChunkAt > SILENCE_RESTART_MS && this.child === child) {
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
    this.retire(child)
    if (this.stopping) return
    // A permanently wedged tap would otherwise respawn every 5s forever, so the
    // watchdog path shares the exit path's budget.
    if (this.restarts >= MAX_RESTARTS) {
      this.emit('exit', { code: null, expected: false, terminal: true })
      this.emit('status', GAVE_UP)
      return
    }
    this.restarts += 1
    setTimeout(() => !this.stopping && this.spawnChild(), 250 * this.restarts)
  }

  /** Detach a helper we no longer want, then kill it. Listeners come off first
   *  so one that ignores SIGTERM can't keep pushing PCM into the same Deepgram
   *  socket as its successor; SIGKILL follows if it hasn't exited. */
  private retire(child: Helper | null): void {
    if (!child) return
    child.stdout.removeAllListeners('data')
    child.stderr.removeAllListeners('data')
    child.kill()
    setTimeout(() => {
      if (this.live.has(child)) child.kill('SIGKILL')
    }, SIGKILL_AFTER_MS)
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
    this.child = null
    for (const child of [...this.live]) this.retire(child)
  }

  get running(): boolean {
    return this.child !== null
  }
}
