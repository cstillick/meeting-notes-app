// Evidence harness for bug #2 (no dedup on Deepgram retransmit) and bug #3
// (epoch reset → non-monotonic timestamps interleave the transcript).
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/segment-dedup.ts
import { createMeeting } from '../../src/main/db/meetings.ts'
import { insertSegment, getSegments, getMaxEndMs } from '../../src/main/db/transcripts.ts'
import { attachRecorder } from './_recorder.ts'
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
const m3 = createMeeting()
const rec = attachRecorder(m3.id)
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
  clamped[2]?.includes('after reconnect') === true,
  'later speech must sort last'
)
header('Re-recording a note: restarting the timeline at 0 drops + interleaves (the bug)')
const mBug = createMeeting()
// Session one.
insertSegment(mBug.id, 'mic', 'hello from session one', 1000, 3000)
insertSegment(mBug.id, 'system', 'remote welcome remarks', 4000, 8000)
// Session two with NO offset (the old behavior): the new Deepgram connection's
// stream time restarts near 0, so the repeated opener collides exactly and
// INSERT OR IGNORE silently drops it, while the rest interleaves into session one.
insertSegment(mBug.id, 'mic', 'hello from session one', 1000, 3000) // exact dup → dropped
insertSegment(mBug.id, 'mic', 'second session new words', 1500, 3500)
const buggy = getSegments(mBug.id)
result(
  'without an offset the repeated opener is silently dropped',
  buggy.filter((s) => s.text === 'hello from session one').length === 1,
  `${buggy.length} rows; "second session" sorts at ${buggy.find((s) => s.text === 'second session new words')?.startMs}ms — inside session one`
)

header('Re-recording a note resumes past the existing transcript (the fix)')
const m4 = createMeeting()
// Session one.
const rec2 = attachRecorder(m4.id)
rec2.onResult('mic', { text: 'hello from session one', startMs: 1000, endMs: 3000, isFinal: true })
rec2.flushPendingMicFinals()
// Stop, then record again. Recorder.start() recomputes baseOffsetMs from the DB,
// so the new session continues past the existing transcript even though the
// connection's stream time (startedAt) restarts near 0.
rec2.baseOffsetMs = getMaxEndMs(m4.id) + 1000
rec2.startedAt = 0
rec2.onResult('mic', { text: 'hello from session one', startMs: 1000, endMs: 3000, isFinal: true })
rec2.onResult('mic', { text: 'second session new words', startMs: 1500, endMs: 3500, isFinal: true })
rec2.flushPendingMicFinals()
const fixed = getSegments(m4.id)
console.log('  resumed order:', JSON.stringify(fixed.map((s) => `${s.startMs}:${s.text}`), null, 2))
result(
  're-recording appends all 3 segments (none dropped by the unique index)',
  fixed.length === 3,
  `${fixed.length} rows (expected 3)`
)
result(
  'resumed segments sort after the first session',
  fixed[fixed.length - 1].text === 'second session new words' &&
    fixed[fixed.length - 1].startMs > fixed[0].endMs,
  fixed.map((s) => `${s.startMs}:${s.text}`).join('  ')
)

console.log('\nsegment-dedup complete')
