// Evidence harness for bug #2 (no dedup on Deepgram retransmit) and bug #3
// (epoch reset → non-monotonic timestamps interleave the transcript).
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/segment-dedup.ts
import { createMeeting } from '../../src/main/db/meetings.ts'
import { insertSegment, getSegments } from '../../src/main/db/transcripts.ts'
import { header, result } from './_util.ts'

header('Retransmitted final segment (reconnect replay)')
const m = createMeeting()
insertSegment(m.id, 'mic', 'we should ship on friday', 1000, 3000)
insertSegment(m.id, 'mic', 'we should ship on friday', 1000, 3000) // Deepgram replay
const dupes = getSegments(m.id)
result('duplicate inserted (bug confirmed if FAIL)', dupes.length === 1, `${dupes.length} rows for 1 utterance`)

header('Epoch jump backwards (reconnect mid-meeting)')
const m2 = createMeeting()
// conn 1: epoch t=0; two segments at 0-3s, 3-6s
insertSegment(m2.id, 'mic', 'first connection segment one', 0, 3000)
insertSegment(m2.id, 'mic', 'first connection segment two', 3000, 6000)
// reconnect: new epoch resets, Deepgram stream times restart near 0 →
// startMs computed lower than already-emitted segments
insertSegment(m2.id, 'mic', 'AFTER RECONNECT spoken later', 500, 2500)
const order = getSegments(m2.id).map((s) => s.text)
console.log('  playback order:', JSON.stringify(order, null, 2))
result(
  'raw DB layer keeps insertion-time order (documents why the recorder must clamp)',
  order[2] !== 'AFTER RECONNECT spoken later',
  'raw inserts have no ordering guarantee — the clamp lives in Recorder.onResult'
)

header('Recorder-level monotonic clamp (the actual fix)')
// recorder guards on meetingId/startedAt; private fields are runtime-accessible.
const { Recorder } = await import('../../src/main/transcription/recorder.ts')
const m3 = createMeeting()
const rec = new Recorder() as unknown as {
  meetingId: string | null
  startedAt: number
  onResult: (
    ch: 'mic' | 'system',
    r: { text: string; startMs: number; endMs: number; isFinal: boolean }
  ) => void
  flushPendingMicFinals: () => void
}
rec.meetingId = m3.id
rec.startedAt = 0
rec.onResult('mic', { text: 'conn one segment one', startMs: 0, endMs: 3000, isFinal: true })
rec.onResult('mic', { text: 'conn one segment two', startMs: 3000, endMs: 6000, isFinal: true })
// reconnect epoch jump backwards: later speech reports an earlier startMs
rec.onResult('mic', { text: 'after reconnect spoken later', startMs: 500, endMs: 2500, isFinal: true })
// mic finals are held briefly for echo suppression — drain before reading
rec.flushPendingMicFinals()
const clamped = getSegments(m3.id).map((s) => `${s.startMs}:${s.text}`)
console.log('  clamped order:', JSON.stringify(clamped, null, 2))
result(
  'recorder clamps reconnect timestamps to stay monotonic',
  clamped[2]?.includes('after reconnect'),
  'later speech must sort last'
)
console.log('\nsegment-dedup complete')
