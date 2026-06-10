// One Deepgram streaming connection for one audio channel (mic or system).
// Speaker identity is the connection: mic = "Me", system = "Them".
import { DeepgramClient } from '@deepgram/sdk'
import { EventEmitter } from 'events'

type V1Socket = Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>>

export interface SessionResult {
  text: string
  /** epoch ms, aligned across connections via the connection-open epoch */
  startMs: number
  endMs: number
  isFinal: boolean
}

const KEEPALIVE_MS = 5000
// WebSocket.OPEN
const OPEN = 1

export class DeepgramSession extends EventEmitter<{
  result: [SessionResult]
  error: [string]
  closed: []
}> {
  private socket: V1Socket | null = null
  private connEpoch = 0
  private lastSentAt = 0
  private keepAliveTimer: NodeJS.Timeout | null = null
  private closingResolve: (() => void) | null = null

  constructor(
    private apiKey: string,
    private label: string
  ) {
    super()
  }

  async start(): Promise<void> {
    const client = new DeepgramClient({ apiKey: this.apiKey })
    const socket = await client.listen.v1.connect({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      Authorization: `token ${this.apiKey}`
    })
    this.socket = socket

    socket.on('open', () => {
      // Reset the timeline anchor on every (re)connect: Deepgram timestamps
      // restart at 0 per connection.
      this.connEpoch = Date.now()
    })

    socket.on('message', (message) => {
      if (message.type !== 'Results') return
      const text = message.channel?.alternatives?.[0]?.transcript ?? ''
      if (!text.trim()) return
      this.emit('result', {
        text,
        startMs: this.connEpoch + message.start * 1000,
        endMs: this.connEpoch + (message.start + message.duration) * 1000,
        isFinal: message.is_final ?? false
      })
    })

    socket.on('error', (err) => {
      this.emit('error', `${this.label}: ${err.message}`)
    })

    socket.on('close', () => {
      this.closingResolve?.()
      this.emit('closed')
    })

    socket.connect()
    await socket.waitForOpen()
    this.connEpoch = Date.now()
    this.lastSentAt = Date.now()

    // Deepgram closes idle connections (~10s without audio): keep alive
    // through device hiccups or helper restarts.
    this.keepAliveTimer = setInterval(() => {
      if (this.socket && Date.now() - this.lastSentAt > KEEPALIVE_MS) {
        try {
          this.socket.sendKeepAlive({ type: 'KeepAlive' })
        } catch {
          // socket mid-reconnect; ReconnectingWebSocket will recover
        }
      }
    }, KEEPALIVE_MS)
  }

  sendAudio(chunk: Buffer): void {
    if (!this.socket || this.socket.readyState !== OPEN) return
    try {
      this.socket.sendMedia(chunk)
      this.lastSentAt = Date.now()
    } catch {
      // dropped chunk during reconnect — acceptable gap
    }
  }

  /** Flush remaining finals and close. Resolves when the server closes (or after a timeout). */
  async stop(): Promise<void> {
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
