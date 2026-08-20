// The transcript suites drive Recorder directly: they set the meeting/timeline
// state that start() would set and feed it results that Deepgram would send.
// Recorder exposes no test seam, so the one cast lives here — the result shape
// and channel type are imported, so changing either fails typecheck, and the
// property names are checked at construction instead of silently binding to
// nothing. Follow-up (src is out of scope for this package): give Recorder an
// `attachForTest(meetingId, startedAt, baseOffsetMs)` method and drop the cast.
import type { Channel } from '../../src/shared/types.ts'
import type { SessionResult } from '../../src/main/transcription/deepgramSession.ts'
import { Recorder } from '../../src/main/transcription/recorder.ts'

export interface RecorderSeam {
  meetingId: string | null
  startedAt: number
  baseOffsetMs: number
  onResult: (channel: Channel, r: SessionResult) => void
  flushPendingMicFinals: () => void
}

const SEAM = ['meetingId', 'startedAt', 'baseOffsetMs', 'onResult', 'flushPendingMicFinals'] as const

export function attachRecorder(meetingId: string, startedAt = 0, baseOffsetMs = 0): RecorderSeam {
  const rec = new Recorder() as unknown as RecorderSeam
  const missing = SEAM.filter((k) => !(k in rec))
  if (missing.length > 0) {
    throw new Error(
      `Recorder no longer has ${missing.join(', ')} — scripts/stress/_recorder.ts is stale and the suites are testing nothing`
    )
  }
  rec.meetingId = meetingId
  rec.startedAt = startedAt
  rec.baseOffsetMs = baseOffsetMs
  return rec
}
