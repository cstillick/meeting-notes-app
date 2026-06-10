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

export class Recorder extends EventEmitter<{
  segment: [LiveSegment]
  status: [RecorderStatus]
}> {
  private meetingId: string | null = null
  private startedAt = 0
  private audiotee: AudioTee | null = null
  private sessions: Partial<Record<Channel, DeepgramSession>> = {}
  private state: RecorderStatus['state'] = 'idle'

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
    this.setState('starting')

    try {
      const mic = new DeepgramSession(apiKey, 'mic')
      const system = new DeepgramSession(apiKey, 'system')
      this.sessions = { mic, system }

      for (const [channel, session] of Object.entries(this.sessions) as [
        Channel,
        DeepgramSession
      ][]) {
        session.on('result', (r) => this.onResult(channel, r))
        session.on('error', (msg) => this.setState(this.state, msg))
      }

      await Promise.all([mic.start(), system.start()])

      this.audiotee = new AudioTee()
      this.audiotee.on('chunk', (buf) => system.sendAudio(buf))
      this.audiotee.on('status', (msg) => this.emit('status', {
        state: this.state,
        meetingId: this.meetingId,
        detail: msg
      }))
      this.audiotee.start()

      this.startedAt = Date.now()
      setStarted(meetingId, this.startedAt)
      this.setState('recording')
      return { ok: true }
    } catch (err) {
      await this.teardown()
      this.meetingId = null
      this.setState('error', err instanceof Error ? err.message : String(err))
      this.setState('idle')
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** PCM from the renderer's mic AudioWorklet. */
  onMicChunk(chunk: Buffer): void {
    if (this.state === 'recording') this.sessions.mic?.sendAudio(chunk)
  }

  private onResult(
    channel: Channel,
    r: { text: string; startMs: number; endMs: number; isFinal: boolean }
  ): void {
    if (!this.meetingId) return
    const startMs = Math.max(0, r.startMs - this.startedAt)
    const endMs = Math.max(startMs, r.endMs - this.startedAt)

    if (r.isFinal) {
      insertSegment(this.meetingId, channel, r.text, startMs, endMs)
    }
    this.emit('segment', { channel, text: r.text, startMs, endMs, isFinal: r.isFinal })
  }

  async stop(): Promise<void> {
    if (this.state !== 'recording' && this.state !== 'starting') return
    const meetingId = this.meetingId
    this.setState('stopping')

    // Stop audio sources first, then let the sessions flush trailing finals.
    this.audiotee?.stop()
    this.audiotee = null
    await this.teardown()

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
