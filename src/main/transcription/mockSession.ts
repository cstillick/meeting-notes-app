// Test-only stand-in for DeepgramSession, enabled with MOCK_DEEPGRAM=1.
// Emits synthetic interim/final results so recording flows (start/stop, persistence,
// quit-mid-recording) can be exercised without network or API usage. It reproduces
// Deepgram's awkward behaviors on demand: duplicate finals, epoch resets, diarized
// speaker turns on the system channel, and (with MOCK_ECHO=1) cross-channel echo.
import { EventEmitter } from 'events'
import type { Channel } from '@shared/types'
import type { SessionOptions, SessionResult } from './deepgramSession'

// Per-channel phrase sets are deliberately disjoint: near-identical text on
// both channels would (correctly) trip the echo suppressor.
const MIC_PHRASES = [
  'taking a quick note about the action items',
  'let me summarize what we decided here',
  'I will follow up with the design team',
  'sounds good I can own that workstream'
]
const SYSTEM_PHRASES = [
  'this is a synthetic transcript segment',
  'we are stress testing the recorder pipeline',
  'duplicate finals and epoch jumps are simulated',
  'the quick brown fox jumps over the lazy dog'
]
// MOCK_ECHO=1: every 4th tick both channels emit the same phrase at overlapping
// times, simulating speaker bleed into the mic. Expect it once (system) in the UI/DB.
const ECHO_PHRASES = [
  'remote audio leaking from the speakers into the microphone',
  'this sentence was played out loud and picked up acoustically'
]
const USE_ECHO = process.env['MOCK_ECHO'] === '1'
// MOCK_LECTURE=1: an in-person recording. The system channel produces nothing
// at all (there is no other app playing audio) and the mic carries several
// voices, so the diarized-mic paths — stable index allocation, the flicker
// dedupe, the skipped echo hold — are exercised without a Core Audio tap.
const USE_LECTURE = process.env['MOCK_LECTURE'] === '1'

export class MockDeepgramSession extends EventEmitter<{
  result: [SessionResult]
  error: [string]
  closed: []
}> {
  private timer: NodeJS.Timeout | null = null
  private connEpoch = 0
  private diarEpoch = 0
  private n = 0

  constructor(
    _apiKey: string,
    private label: Channel,
    private opts: SessionOptions = { diarize: label === 'system' }
  ) {
    super()
  }

  async start(): Promise<void> {
    this.connEpoch = Date.now()
    this.timer = setInterval(() => this.tick(), 400)
  }

  private tick(): void {
    // A lecture has no system audio at all: the tap would be silent, so the
    // session emits nothing rather than fabricating remote speech.
    if (USE_LECTURE && this.label === 'system') return
    const isEchoTick = USE_ECHO && this.n % 4 === 3
    const phrases = this.label === 'mic' ? MIC_PHRASES : SYSTEM_PHRASES
    const text = isEchoTick
      ? ECHO_PHRASES[this.n % ECHO_PHRASES.length]
      : `${phrases[this.n % phrases.length]} (${this.label} ${this.n})`
    const start = this.n * 1500
    const base: Omit<SessionResult, 'isFinal'> = {
      text,
      startMs: this.connEpoch + start,
      endMs: this.connEpoch + start + 1400,
      speakerEpoch: this.diarEpoch
    }
    // Rotate three speakers on whichever channel the Recorder asked to diarize.
    if (this.opts.diarize) base.speaker = Math.floor(this.n / 3) % 3
    this.emit('result', { ...base, isFinal: false })
    this.emit('result', { ...base, isFinal: true })
    // Simulate a Deepgram retransmit every 5th final. In lecture mode the
    // retransmit carries a DIFFERENT speaker index — streaming diarization
    // flickers on replays — which is a duplicate row under the unique index
    // unless commitFinal dedupes on text and time alone.
    if (this.n % 5 === 4) {
      const replay =
        USE_LECTURE && base.speaker !== undefined
          ? { ...base, speaker: (base.speaker + 1) % 3 }
          : base
      this.emit('result', { ...replay, isFinal: true })
    }
    // Simulate a reconnect (epoch reset) every 8th segment. Speaker numbering
    // restarts with the connection, so the diarization epoch moves too.
    if (this.n % 8 === 7) {
      this.connEpoch = Date.now()
      this.diarEpoch += 1
    }
    this.n++
  }

  sendAudio(_chunk: Buffer): void {
    // discard — synthetic results are timer-driven
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.emit('closed')
  }
}
