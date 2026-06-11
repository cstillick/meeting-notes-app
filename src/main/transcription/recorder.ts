// The heart of the app: owns the recording lifecycle for one meeting.
// Routes mic PCM (from the renderer) and system PCM (from audiotee) into two
// Deepgram sessions, persists final segments, and streams everything live to
// the renderer. PCM exists only in memory and the outbound websockets.
import { EventEmitter } from 'events'
import type { Channel, LiveSegment, RecorderStatus } from '@shared/types'
import { AudioTee } from '../audio/audiotee'
import { getDeepgramKey } from '../settings'
import { getMeeting, setEnded, setStarted } from '../db/meetings'
import { insertSegment } from '../db/transcripts'
import { reindexMeeting } from '../db/search'
import { DeepgramSession } from './deepgramSession'
import { MockDeepgramSession } from './mockSession'
import { EchoSuppressor } from './echoSuppressor'
import { buildStamp, echoLog } from './debugLog'

// MOCK_DEEPGRAM=1: synthetic transcription, no network. Test scaffolding only.
const USE_MOCK = process.env['MOCK_DEEPGRAM'] === '1'
// Every mic-final echo decision is logged with the suppressor's internals
// (coverage, window union, nearest system-entry delta, confidence) to
// userData/echo-debug.log, so leaks are diagnosed from measurements instead
// of inferred after the fact. ECHO_DEBUG=1 additionally mirrors to stdout.
const ECHO_DEBUG = process.env['ECHO_DEBUG'] === '1'

type Session = DeepgramSession | MockDeepgramSession

interface PendingMicFinal {
  text: string
  startMs: number
  endMs: number
  speaker?: number
  confidence?: number
  timer: NodeJS.Timeout
}

/** Errors from the Deepgram SDK can be plain objects; String() would yield "[object Object]". */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const o = err as { message?: unknown; error?: unknown; reason?: unknown }
    for (const v of [o.message, o.error, o.reason]) {
      if (typeof v === 'string' && v) return v
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

export class Recorder extends EventEmitter<{
  segment: [LiveSegment]
  status: [RecorderStatus]
}> {
  private meetingId: string | null = null
  private startedAt = 0
  private audiotee: AudioTee | null = null
  private sessions: Partial<Record<Channel, Session>> = {}
  private state: RecorderStatus['state'] = 'idle'
  /** Last persisted final start per channel — Deepgram epoch resets on
   *  reconnect can move timestamps backwards; clamp to keep order stable. */
  private lastFinalStart: Partial<Record<Channel, number>> = {}
  private suppressor = new EchoSuppressor()
  /** Mic finals are held briefly before persisting: the matching system final
   *  may arrive after the mic copy of an echo, so committing immediately would
   *  require retroactive deletes. Interims still stream instantly. */
  private pendingMicFinals: PendingMicFinal[] = []
  private static readonly MIC_FINAL_HOLD_MS = 3500

  get currentMeetingId(): string | null {
    return this.meetingId
  }

  get recording(): boolean {
    return this.state === 'recording'
  }

  private setState(state: RecorderStatus['state'], detail?: string): void {
    this.state = state
    this.emit('status', { state, meetingId: this.meetingId, detail })
  }

  async start(meetingId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state !== 'idle') {
      return { ok: false, error: 'Already recording' }
    }
    if (!getMeeting(meetingId)) {
      return { ok: false, error: 'Meeting not found' }
    }
    const apiKey = getDeepgramKey()
    if (!apiKey) {
      return { ok: false, error: 'Deepgram API key not set — add it in Settings' }
    }

    this.meetingId = meetingId
    this.lastFinalStart = {}
    this.suppressor.reset()
    this.clearPendingMicFinals()
    this.setState('starting')

    try {
      const Ctor = USE_MOCK ? MockDeepgramSession : DeepgramSession
      const mic = new Ctor(apiKey, 'mic')
      const system = new Ctor(apiKey, 'system')
      this.sessions = { mic, system }

      for (const [channel, session] of Object.entries(this.sessions) as [
        Channel,
        Session
      ][]) {
        session.on('result', (r) => this.onResult(channel, r))
        session.on('error', (msg) => this.setState(this.state, msg))
      }

      // Spawn the system-audio tap before awaiting the sockets: the helper
      // takes up to a few seconds to deliver its first chunk (process launch
      // + Core Audio tap setup), so starting it last loses that much system
      // audio. Chunks that land before the socket opens are dropped by
      // sendAudio's readyState guard; the timeline anchors on the first chunk
      // that actually goes out.
      if (!USE_MOCK) {
        this.audiotee = new AudioTee()
        this.audiotee.on('chunk', (buf) => system.sendAudio(buf))
        this.audiotee.on('status', (msg) => this.emit('status', {
          state: this.state,
          meetingId: this.meetingId,
          detail: msg
        }))
        this.audiotee.start()
      }

      await Promise.all([mic.start(), system.start()])

      this.startedAt = Date.now()
      setStarted(meetingId, this.startedAt)
      this.setState('recording')
      echoLog(`start meeting=${meetingId} build=${buildStamp()}`)
      return { ok: true }
    } catch (err) {
      this.audiotee?.stop()
      this.audiotee = null
      await this.teardown()
      this.meetingId = null
      this.setState('error', errorMessage(err))
      this.setState('idle')
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** PCM from the renderer's mic AudioWorklet. */
  onMicChunk(chunk: Buffer): void {
    if (this.state === 'recording') this.sessions.mic?.sendAudio(chunk)
  }

  private onResult(
    channel: Channel,
    r: {
      text: string
      startMs: number
      endMs: number
      isFinal: boolean
      speaker?: number
      confidence?: number
    }
  ): void {
    if (!this.meetingId) return
    const startMs = Math.max(0, r.startMs - this.startedAt)
    const endMs = Math.max(startMs, r.endMs - this.startedAt)

    if (channel === 'system') {
      // Every system result (interims too — they arrive seconds early) feeds
      // the echo matcher, then retracts any held mic final it now exposes.
      this.suppressor.observeSystem(r.text, startMs, endMs)
      this.retractMatchedPending()
      if (r.isFinal) {
        this.commitFinal(channel, r.text, startMs, endMs, r.speaker)
      } else {
        this.emit('segment', {
          channel,
          text: r.text,
          startMs,
          endMs,
          isFinal: false,
          speaker: r.speaker
        })
      }
      return
    }

    // Mic: anything that duplicates overlapping system speech is acoustic
    // echo of remote audio (speakers → mic), not the user talking.
    if (!r.isFinal) {
      if (this.suppressor.isEcho(r.text, startMs, endMs)) {
        this.emitSuppressed(startMs, endMs, false)
      } else {
        this.emit('segment', { channel, text: r.text, startMs, endMs, isFinal: false })
      }
      return
    }

    if (this.checkEcho('mic final', r.text, startMs, endMs, r.confidence)) {
      this.emitSuppressed(startMs, endMs, true)
      return
    }
    const pending: PendingMicFinal = {
      text: r.text,
      startMs,
      endMs,
      speaker: r.speaker,
      confidence: r.confidence,
      timer: setTimeout(() => this.flushMicFinal(pending), Recorder.MIC_FINAL_HOLD_MS)
    }
    this.pendingMicFinals.push(pending)
  }

  /** Clamp against epoch resets, persist, and emit one final segment. */
  private commitFinal(
    channel: Channel,
    text: string,
    startMs: number,
    endMs: number,
    speaker?: number
  ): void {
    if (!this.meetingId) return
    const floor = this.lastFinalStart[channel]
    if (floor !== undefined && startMs < floor) {
      const shift = floor - startMs
      startMs += shift
      endMs += shift
    }
    this.lastFinalStart[channel] = startMs
    insertSegment(this.meetingId, channel, text, startMs, endMs, speaker ?? null)
    this.emit('segment', { channel, text, startMs, endMs, isFinal: true, speaker })
  }

  /** isEcho, with the decision logged to echo-debug.log (and stdout under ECHO_DEBUG=1). */
  private checkEcho(
    stage: string,
    text: string,
    startMs: number,
    endMs: number,
    confidence?: number
  ): boolean {
    const v = this.suppressor.evaluate(text, startMs, endMs)
    const delta = v.nearestStartDeltaMs === null ? 'none' : `${Math.round(v.nearestStartDeltaMs)}ms`
    const line =
      `${stage} [${Math.round(startMs)}-${Math.round(endMs)}] ` +
      `echo=${v.isEcho} coverage=${v.coverage.toFixed(2)} tokens=${v.micTokenCount} ` +
      `union=${v.unionSize} entries=${v.entryCount} nearestSysDelta=${delta} ` +
      `conf=${confidence === undefined ? 'n/a' : confidence.toFixed(2)} "${text}"`
    echoLog(line)
    if (ECHO_DEBUG) console.log(`[echo] ${line}`)
    return v.isEcho
  }

  /** Tell the renderer to clear the live mic bubble for an echo. */
  private emitSuppressed(startMs: number, endMs: number, isFinal: boolean): void {
    this.emit('segment', { channel: 'mic', text: '', startMs, endMs, isFinal, suppressed: true })
  }

  private flushMicFinal(pending: PendingMicFinal): void {
    const idx = this.pendingMicFinals.indexOf(pending)
    if (idx === -1) return
    this.pendingMicFinals.splice(idx, 1)
    clearTimeout(pending.timer)
    // Last echo check: the matching system final may have landed during the hold.
    if (this.checkEcho('mic flush', pending.text, pending.startMs, pending.endMs, pending.confidence)) {
      this.emitSuppressed(pending.startMs, pending.endMs, true)
      return
    }
    this.commitFinal('mic', pending.text, pending.startMs, pending.endMs, pending.speaker)
  }

  /** Drop held mic finals that a newly arrived system result revealed as echo. */
  private retractMatchedPending(): void {
    for (const pending of [...this.pendingMicFinals]) {
      // Runs on every system result, so only the (rare) retractions are
      // logged — the per-final decision points log every verdict.
      if (this.suppressor.isEcho(pending.text, pending.startMs, pending.endMs)) {
        echoLog(
          `mic retract [${Math.round(pending.startMs)}-${Math.round(pending.endMs)}] "${pending.text}"`
        )
        const idx = this.pendingMicFinals.indexOf(pending)
        if (idx !== -1) this.pendingMicFinals.splice(idx, 1)
        clearTimeout(pending.timer)
        this.emitSuppressed(pending.startMs, pending.endMs, true)
      }
    }
  }

  /** Resolve all held mic finals immediately (echo check, then commit). */
  flushPendingMicFinals(): void {
    for (const pending of [...this.pendingMicFinals]) this.flushMicFinal(pending)
    this.clearPendingMicFinals()
  }

  private clearPendingMicFinals(): void {
    for (const pending of this.pendingMicFinals) clearTimeout(pending.timer)
    this.pendingMicFinals = []
  }

  async stop(): Promise<void> {
    if (this.state !== 'recording' && this.state !== 'starting') return
    const meetingId = this.meetingId
    this.setState('stopping')

    // Stop audio sources first, then let the sessions flush trailing finals.
    this.audiotee?.stop()
    this.audiotee = null
    await this.teardown()

    // Sessions have flushed, so the system buffer is complete: resolve any
    // still-held mic finals now, before the search reindex below.
    this.flushPendingMicFinals()

    if (meetingId) {
      setEnded(meetingId, Date.now())
      reindexMeeting(meetingId)
    }
    this.meetingId = null
    this.setState('idle')
  }

  private async teardown(): Promise<void> {
    const sessions = Object.values(this.sessions)
    this.sessions = {}
    await Promise.all(sessions.map((s) => s.stop().catch(() => undefined)))
  }
}

export const recorder = new Recorder()
