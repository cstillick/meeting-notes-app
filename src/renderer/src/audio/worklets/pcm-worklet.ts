// AudioWorklet processor: downsamples the mic's float32 stream (typically
// 48 kHz) to 16 kHz s16le mono and posts ~50 ms chunks to the main thread.
//
// Each output sample is the mean of the input samples that fall in its window —
// a boxcar, which is better than naive decimation but is NOT a real anti-alias
// filter: at 48 kHz it folds 10 kHz energy down onto 6 kHz at only about
// -5.9 dB, right into the formant band a diarizer clusters on. When the caller
// can open the AudioContext at 16 kHz (the far-field profiles do), the ratio
// below is 1, this degenerates to a pass-through, and Chromium's sinc resampler
// does the conversion properly instead.

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
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const channel = channels[0]
    if (!channel) return true
    // Downmix every channel present. Requesting echoCancellation forces macOS
    // capture into a mono voice-processing path, which is why taking channel 0
    // alone was harmless before — the far-field profiles turn that off, so a
    // stereo interface would otherwise silently lose half the room.
    const channelCount = channels.length

    for (let i = 0; i < channel.length; i++) {
      let sample = 0
      for (let c = 0; c < channelCount; c++) sample += channels[c][i]
      this.acc += sample / channelCount
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
