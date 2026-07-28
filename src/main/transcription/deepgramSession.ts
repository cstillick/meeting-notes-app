// One Deepgram streaming connection for one audio channel (mic or system).
// Channel identity maps to speakers: mic = "Me"; the system channel is
// diarized, so each result may carry a speaker index ("Speaker 1", ...).
import { DeepgramClient } from '@deepgram/sdk'
import { EventEmitter } from 'events'
import type { Channel } from '@shared/types'

type V1Socket = Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>>

export interface SessionResult {
  text: string
  /** epoch ms, aligned across connections via the first-audio epoch */
  startMs: number
  endMs: number
  isFinal: boolean
  /** Diarized speaker index (system channel only; indices reset per connection). */
  speaker?: number
  /** Mean word confidence (0–1), when the result carries word data. */
  confidence?: number
}

interface ResultWord {
  word: string
  punctuated_word?: string
  start: number
  end: number
  speaker?: number
  confidence?: number
}

function meanConfidence(words: ResultWord[]): number | undefined {
  const vals = words.map((w) => w.confidence).filter((c): c is number => typeof c === 'number')
  if (vals.length === 0) return undefined
  return vals.reduce((sum, c) => sum + c, 0) / vals.length
}

const KEEPALIVE_MS = 5000
// How long the SDK's ReconnectingWebSocket gets to come back after an
// unexpected close before the connection counts as dead.
const RECONNECT_GRACE_MS = 10_000
// WebSocket.OPEN
const OPEN = 1

export class DeepgramSession extends EventEmitter<{
  result: [SessionResult]
  error: [string]
  closed: []
  /** The connection is gone for good — every chunk from here on is discarded. */
  dead: [string]
}> {
  private socket: V1Socket | null = null
  private connEpoch = 0
  private awaitingFirstAudio = true
  private lastSentAt = 0
  private keepAliveTimer: NodeJS.Timeout | null = null
  private closingResolve: (() => void) | null = null
  private stopping = false
  private isDead = false
  private keepAliveStrikes = 0

  constructor(
    private apiKey: string,
    private label: Channel
  ) {
    super()
  }

  async start(): Promise<void> {
    this.stopping = false
    this.isDead = false
    this.keepAliveStrikes = 0
    const client = new DeepgramClient({ apiKey: this.apiKey })
    const socket = await client.listen.v1.connect({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      // Only the system channel carries multiple voices; the mic is always "Me".
      diarize: this.label === 'system' ? 'true' : 'false',
      Authorization: `token ${this.apiKey}`
    })
    this.socket = socket

    socket.on('open', () => {
      // Re-anchor on every (re)connect: Deepgram timestamps restart at 0 per
      // connection and count audio-stream time, i.e. from the first chunk
      // sent — not from WS-open. Anchoring at open would shift a channel
      // whose audio source starts late (audiotee takes a moment to spawn its
      // Core Audio tap) earlier than the mic channel, breaking the echo
      // suppressor's cross-channel time matching. So open only arms the
      // anchor; sendAudio() sets it on the first chunk.
      this.connEpoch = Date.now()
      this.awaitingFirstAudio = true
    })

    socket.on('message', (message) => {
      if (message.type !== 'Results') return
      const alt = message.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''
      if (!text.trim()) return
      const isFinal = message.is_final ?? false
      const words = (alt?.words ?? []) as ResultWord[]

      // Finals with diarized words split into one result per speaker turn so
      // each segment carries a single speaker. Interims stay whole (one live
      // bubble per channel); the final split corrects the display in ~2s.
      if (isFinal && words.length > 0 && words.some((w) => w.speaker !== undefined)) {
        for (const group of this.groupWordsBySpeaker(words)) {
          this.emit('result', {
            text: group.text,
            startMs: this.connEpoch + group.start * 1000,
            endMs: this.connEpoch + group.end * 1000,
            isFinal: true,
            speaker: group.speaker,
            confidence: group.confidence
          })
        }
        return
      }

      const lastSpeaker = words.length > 0 ? words[words.length - 1].speaker : undefined
      this.emit('result', {
        text,
        startMs: this.connEpoch + message.start * 1000,
        endMs: this.connEpoch + (message.start + message.duration) * 1000,
        isFinal,
        speaker: lastSpeaker,
        confidence: meanConfidence(words)
      })
    })

    socket.on('error', (err) => {
      this.emit('error', `${this.label}: ${err.message}`)
    })

    socket.on('close', () => {
      this.closingResolve?.()
      this.emit('closed')
      if (this.stopping) return
      // A close is not automatically fatal — the SDK reconnects — except on
      // code 1000, where it disables reconnection permanently and the socket
      // reports CLOSED forever while sendAudio silently drops every chunk.
      setTimeout(() => {
        if (this.socket === socket && socket.readyState !== OPEN) {
          this.markDead('connection closed and did not reconnect')
        }
      }, RECONNECT_GRACE_MS)
    })

    socket.connect()
    await socket.waitForOpen()
    // Fallback anchor only — overwritten by the first sendAudio().
    this.connEpoch = Date.now()
    this.awaitingFirstAudio = true
    this.lastSentAt = Date.now()

    // Deepgram closes idle connections (~10s without audio): keep alive
    // through device hiccups or helper restarts.
    this.keepAliveTimer = setInterval(() => {
      if (this.socket && Date.now() - this.lastSentAt > KEEPALIVE_MS) {
        try {
          this.socket.sendKeepAlive({ type: 'KeepAlive' })
          this.keepAliveStrikes = 0
        } catch {
          // One throw is a socket mid-reconnect; ReconnectingWebSocket recovers
          // from those. Two in a row means it has given up, and this is the only
          // recurring code path that touches the socket — nothing else would
          // ever notice, since sendAudio returns quietly on a closed one.
          this.keepAliveStrikes += 1
          if (this.keepAliveStrikes >= 2) this.markDead('transcription connection lost')
        }
      }
    }, KEEPALIVE_MS)
  }

  private markDead(reason: string): void {
    if (this.isDead || this.stopping) return
    this.isDead = true
    this.emit('dead', `${this.label}: ${reason}`)
  }

  /** Group consecutive words sharing a speaker index into one segment each. */
  private groupWordsBySpeaker(
    words: ResultWord[]
  ): Array<{ text: string; start: number; end: number; speaker?: number; confidence?: number }> {
    const groups: Array<{ words: ResultWord[]; speaker?: number }> = []
    for (const w of words) {
      const last = groups[groups.length - 1]
      if (last && last.speaker === w.speaker) last.words.push(w)
      else groups.push({ words: [w], speaker: w.speaker })
    }
    // Streaming diarization flickers on word boundaries — a final like
    // "Let's do it." can tag the trailing "it." with a different speaker,
    // fabricating a phantom one-word turn. Absorb single-word groups into
    // their neighbor; a one-word final (a genuine "Yes." turn) has no
    // neighbor and is untouched.
    const smoothed: typeof groups = []
    for (const g of groups) {
      const prev = smoothed[smoothed.length - 1]
      if (prev && g.words.length === 1) prev.words.push(...g.words)
      else smoothed.push(g)
    }
    if (smoothed.length >= 2 && smoothed[0].words.length === 1) {
      const [first, second] = smoothed
      second.words.unshift(...first.words)
      smoothed.shift()
    }
    return smoothed.map((g) => ({
      text: g.words.map((w) => w.punctuated_word ?? w.word).join(' '),
      start: g.words[0].start,
      end: g.words[g.words.length - 1].end,
      speaker: g.speaker,
      confidence: meanConfidence(g.words)
    }))
  }

  sendAudio(chunk: Buffer): void {
    if (!this.socket || this.socket.readyState !== OPEN) return
    try {
      this.socket.sendMedia(chunk)
      if (this.awaitingFirstAudio) {
        // This chunk is audio-stream time 0: anchor here so timestamps are
        // wall-aligned regardless of how long the audio source took to start.
        this.connEpoch = Date.now()
        this.awaitingFirstAudio = false
      }
      this.lastSentAt = Date.now()
    } catch {
      // dropped chunk during reconnect — acceptable gap
    }
  }

  /** Flush remaining finals and close. Resolves when the server closes (or after a timeout). */
  async stop(): Promise<void> {
    // Set before anything closes: teardown closes the socket on purpose and
    // must not be reported as a dead connection.
    this.stopping = true
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    const socket = this.socket
    if (!socket) return
    this.socket = null

    const closed = new Promise<void>((resolve) => {
      this.closingResolve = resolve
    })
    try {
      socket.sendCloseStream({ type: 'CloseStream' })
    } catch {
      socket.close()
      return
    }
    // Wait for the server to deliver trailing finals + close, but don't hang.
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 3000))])
    socket.close()
  }
}
