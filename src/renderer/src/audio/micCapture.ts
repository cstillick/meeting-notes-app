// Mic capture in the renderer: getUserMedia (Chromium AEC/noise suppression on)
// -> AudioWorklet downsampler -> 16 kHz s16le chunks over IPC to the main
// process. PCM lives only in memory; nothing is written to disk.
import workletUrl from './worklets/pcm-worklet?worker&url'

export interface MicCapture {
  stop: () => void
  /** 0..1 rough level for a meter, updated per chunk */
  getLevel: () => number
}

export async function startMicCapture(): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const ctx = new AudioContext()
  await ctx.audioWorklet.addModule(workletUrl)

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-processor')

  let level = 0
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
    const buf = e.data
    // crude peak meter from the s16 chunk
    const samples = new Int16Array(buf)
    let peak = 0
    for (let i = 0; i < samples.length; i += 8) {
      const v = Math.abs(samples[i])
      if (v > peak) peak = v
    }
    level = peak / 0x8000
    window.api.send('mic:pcm', buf)
  }

  source.connect(node)
  // Worklet needs to be pulled by the graph; route to a muted gain node.
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(ctx.destination)

  return {
    stop: (): void => {
      node.port.onmessage = null
      node.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
    getLevel: (): number => level
  }
}
