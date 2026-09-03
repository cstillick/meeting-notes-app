// Mic capture in the renderer: getUserMedia -> AudioWorklet downsampler ->
// 16 kHz s16le chunks over IPC to the main process. PCM lives only in memory;
// nothing is written to disk.
//
// The constraints depend on what is being recorded, because the browser's voice
// processing is tuned for a headset on a call and actively destroys the cues a
// diarizer needs in a room:
//
//   - autoGainControl normalises level over time. That is precisely the
//     per-speaker loudness/distance cue that separates a professor at the
//     lectern from the student holding the laptop — and worse, its release ramps
//     gain DURING a single four-second question, so one utterance yields two
//     different embeddings and the clusterer splits it in half.
//   - noiseSuppression attenuates the reverberant tail, which past a room's
//     critical distance is the only distance cue left, and attenuates it hardest
//     on the lowest-SNR talker: the distant one you most need separated.
//   - echoCancellation is the one to KEEP whenever system audio is playing —
//     it is what stops remote speech reaching the mic and makes the echo
//     suppressor's job tractable. In a room with no call there is no echo to
//     cancel, so it only costs signal.
import workletUrl from './worklets/pcm-worklet?worker&url'

/** Which capture profile to open the microphone with.
 *  - 'call'      remote meeting: browser voice processing on, as before.
 *  - 'room'      in person, no call: far-field, nothing playing to cancel.
 *  - 'room_call' a room joined to a call: far-field, but echo cancellation on. */
export type CaptureProfile = 'call' | 'room' | 'room_call'

/** Deepgram's rate. Asking the AudioContext for it directly hands resampling to
 *  Chromium's sinc resampler instead of the worklet's 3-tap boxcar, which folds
 *  10 kHz energy down onto 6 kHz — straight into the formant band a diarizer
 *  clusters on. */
const TARGET_RATE = 16000
/** Peak the frozen makeup gain aims for. Below full scale by a wide margin: the
 *  point is audibility, not loudness, and clipping is unrecoverable. */
const TARGET_PEAK = 0.25
const MAX_MAKEUP_GAIN = 8
/** How long to observe before fixing the gain. Long enough for a real phrase,
 *  short enough that the opening of a lecture is not lost to it. */
const GAIN_CALIBRATION_MS = 3000
/** Rumble, HVAC and desk thumps live below this and carry no speech. */
const HIGHPASS_HZ = 80

export interface MicCapture {
  stop: () => void
  /** 0..1 level for a meter, mapped from dBFS with a -60 dBFS floor. */
  getLevel: () => number
  /** Non-null when the OS ignored the far-field constraints, so the caller can
   *  say so rather than silently reporting a quality fix that never applied. */
  warning: string | null
}

function constraintsFor(profile: CaptureProfile): MediaTrackConstraints {
  if (profile === 'call') {
    // Unchanged from before profiles existed. The remote-meeting path is the
    // common one and has a documented echo-leak history; it is not the place to
    // land a change whose sign is uncertain.
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }
  return {
    // Only a hybrid room has far-end audio to cancel.
    echoCancellation: profile === 'room_call',
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: TARGET_RATE
  }
}

/** Constraints are requests, not guarantees. Without checking, a silent no-op
 *  would make every downstream quality claim meaningless. */
function checkApplied(track: MediaStreamTrack): string | null {
  const s = track.getSettings() as MediaTrackSettings
  const stuck: string[] = []
  if (s.noiseSuppression === true) stuck.push('noise suppression')
  if (s.autoGainControl === true) stuck.push('automatic gain control')
  if (stuck.length === 0) return null
  return `This mic keeps ${stuck.join(' and ')} on, which blurs the differences between voices. Speaker separation may be worse than it could be.`
}

export async function startMicCapture(
  opts: { profile: CaptureProfile } = { profile: 'call' }
): Promise<MicCapture> {
  const farField = opts.profile !== 'call'
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: constraintsFor(opts.profile)
  })

  const track = stream.getAudioTracks()[0]
  const warning = farField && track ? checkApplied(track) : null
  if (warning) window.api.send('log:error', `micCapture: ${warning}`)

  // Ask for Deepgram's rate directly when we can; the browser may refuse, in
  // which case the worklet's own downsampling still runs.
  const ctx = farField ? new AudioContext({ sampleRate: TARGET_RATE }) : new AudioContext()
  await ctx.audioWorklet.addModule(workletUrl)

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-processor')

  // Far-field chain: high-pass out the rumble, then ONE fixed makeup gain
  // measured over the first few seconds and then frozen. Never adaptive — an
  // adaptive gain is automatic gain control by another name, and would
  // reintroduce exactly the intra-utterance ramp turning AGC off removed.
  let head: AudioNode = source
  let makeup: GainNode | null = null
  if (farField) {
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = HIGHPASS_HZ
    head.connect(highpass)
    makeup = ctx.createGain()
    makeup.gain.value = 1
    highpass.connect(makeup)
    head = makeup
  }
  head.connect(node)

  let level = 0
  let calibrationPeak = 0
  const calibrationEnds = farField ? performance.now() + GAIN_CALIBRATION_MS : 0
  let gainFrozen = !farField

  node.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
    const buf = e.data
    // True peak over every sample: the old 8:1 stride under-reported it badly
    // enough that normal speech showed an empty meter.
    const samples = new Int16Array(buf)
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i])
      if (v > peak) peak = v
    }
    const normalized = peak / 0x8000
    // dBFS with a -60 floor: linear peak spends almost its whole range on levels
    // too loud to occur, so healthy speech at -20 dBFS looked like silence.
    level = normalized <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(normalized) + 60) / 60))

    if (!gainFrozen && makeup) {
      if (normalized > calibrationPeak) calibrationPeak = normalized
      if (performance.now() >= calibrationEnds) {
        gainFrozen = true
        if (calibrationPeak > 0) {
          makeup.gain.value = Math.max(1, Math.min(MAX_MAKEUP_GAIN, TARGET_PEAK / calibrationPeak))
        }
      }
    }
    window.api.send('mic:pcm', buf)
  }

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
    getLevel: (): number => level,
    warning
  }
}
