// AudioWorklet processor: downsamples the mic's float32 stream (typically
// 48 kHz) to 16 kHz s16le mono and posts ~50 ms chunks to the main thread.
// Averages each input group rather than naively decimating (avoids aliasing).

// AudioWorklet globals (not in the DOM lib)
declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor
): void

const TARGET_RATE = 16000
const CHUNK_SAMPLES = TARGET_RATE / 20 // 50 ms = 800 samples

class PcmProcessor extends AudioWorkletProcessor {
  private ratio = sampleRate / TARGET_RATE
  private acc = 0
  private accCount = 0
  private cursor = 0
  private out = new Int16Array(CHUNK_SAMPLES)
  private outIndex = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i]
      this.accCount += 1
      this.cursor += 1
      if (this.cursor >= this.ratio) {
        this.cursor -= this.ratio
        const avg = this.acc / this.accCount
        this.acc = 0
        this.accCount = 0
        const clamped = Math.max(-1, Math.min(1, avg))
        this.out[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
        if (this.outIndex === CHUNK_SAMPLES) {
          const copy = this.out.slice()
          this.port.postMessage(copy.buffer, [copy.buffer])
          this.outIndex = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
