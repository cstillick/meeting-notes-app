// One Deepgram streaming connection for one audio channel (mic or system).
// Whether a channel is diarized is the Recorder's call, not the channel's: a
// remote meeting puts one voice on the mic, an in-person one puts the whole
// room there. Diarized results carry a speaker index, which Deepgram restarts
// at 0 on every reconnect — hence speakerEpoch below.
import { DeepgramClient } from '@deepgram/sdk'
import { EventEmitter } from 'events'
import type { Channel } from '@shared/types'

type V1Socket = Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>>

/** Per-connection transcription settings. Defaults keep the historical shape:
 *  system diarized, mic not, no endpointing override. */
export interface SessionOptions {
  diarize: boolean
  /** ms of silence that ends an utterance. Deepgram's default is 10ms, which
   *  chops a lecturer's thinking pauses into many short finals — and a final's
   *  length IS the diarization granularity you see, so short finals mean small,
   *  low-quality speaker windows and flip-flopping labels. Omitted = default. */
  endpointingMs?: number
}

export interface SessionResult {
  text: string
  /** epoch ms, aligned across connections via the first-audio epoch */
  startMs: number
  endMs: number
  isFinal: boolean
  /** Diarized speaker index, meaningful only within one speakerEpoch. */
  speaker?: number
  /** Which connection produced `speaker`. Deepgram restarts speaker numbering
   *  at 0 on every reconnect, so an index means nothing across epochs; the
   *  Recorder maps (epoch, index) onto an index that is stable for the note. */
  speakerEpoch?: number
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
  /** Sockets opened on this session; the first is not a reconnect. */
  private opens = 0
  /** Bumped on every reconnect, so speaker indices from different connections
   *  never collide in the Recorder's allocator. */
  private diarEpoch = 0
  private awaitingFirstAudio = true
  private lastSentAt = 0
  private keepAliveTimer: NodeJS.Timeout | null = null
  private closingResolve: (() => void) | null = null
  private stopping = false
  private isDead = false
  private keepAliveStrikes = 0

  constructor(
    private apiKey: string,
    private label: Channel,
    private opts: SessionOptions = { diarize: label === 'system' }
  ) {
    super()
  }

  async start(): Promise<void> {
    this.stopping = false
    this.isDead = false
    this.keepAliveStrikes = 0
    this.opens = 0
    this.diarEpoch = 0
    const client = new DeepgramClient({ apiKey: this.apiKey })
    const socket = await client.listen.v1.connect({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      // Which channels carry multiple voices depends on the recording: an
      // in-person note puts the whole room on the mic. The Recorder decides per
      // note from meetings.audio_source.
      //
      // Do NOT send diarize_model here: streaming has no such parameter (it is
      // absent from V1Client.ConnectArgs and the API rejects it with a 400), so
      // the websocket path is pinned to Deepgram's v1 diarizer. The batch
      // importer, which can select v2, is the higher-quality path.
      diarize: this.opts.diarize ? 'true' : 'false',
      ...(this.opts.endpointingMs === undefined
        ? {}
        : { endpointing: String(this.opts.endpointingMs) }),
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
      // Speaker numbering restarts with the connection, so anything after the
      // first open is a new namespace.
      if (this.opens++ > 0) this.diarEpoch += 1
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
            speakerEpoch: this.diarEpoch,
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
        speakerEpoch: this.diarEpoch,
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
