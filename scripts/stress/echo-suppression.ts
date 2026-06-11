// Evidence harness for cross-channel echo suppression: without headphones,
// remote audio (YouTube/Zoom over speakers) reaches the mic acoustically and
// the same speech used to land as both "Me" and "Them". The Recorder must keep
// exactly one copy (system channel), without dropping real user speech.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/echo-suppression.ts
import { createMeeting } from '../../src/main/db/meetings.ts'
import { insertSegment, getSegments } from '../../src/main/db/transcripts.ts'
import { Recorder } from '../../src/main/transcription/recorder.ts'
import { header, result } from './_util.ts'

type TestRecorder = {
  meetingId: string | null
  startedAt: number
  onResult: (
    ch: 'mic' | 'system',
    r: { text: string; startMs: number; endMs: number; isFinal: boolean; speaker?: number }
  ) => void
  flushPendingMicFinals: () => void
}

function makeRecorder(meetingId: string): TestRecorder {
  const rec = new Recorder() as unknown as TestRecorder
  rec.meetingId = meetingId
  rec.startedAt = 0
  return rec
}

header('System final first, identical overlapping mic final → 1 row')
{
  const m = createMeeting()
  const rec = makeRecorder(m.id)
  rec.onResult('system', {
    text: 'Welcome back to the channel, today we are reviewing the new laptop.',
    startMs: 0,
    endMs: 3000,
    isFinal: true
  })
  rec.onResult('mic', {
    text: 'welcome back to the channel today we are reviewing the new laptop',
    startMs: 100,
    endMs: 3100,
    isFinal: true
  })
  rec.flushPendingMicFinals()
  const rows = getSegments(m.id)
  result(
    'echo dropped, system copy kept',
    rows.length === 1 && rows[0].channel === 'system',
    `${rows.length} rows: ${rows.map((r) => r.channel).join(', ')}`
  )
}

header('Mic final arrives BEFORE matching system final → retracted from hold buffer')
{
  const m = createMeeting()
  const rec = makeRecorder(m.id)
  rec.onResult('mic', {
    text: 'the quarterly numbers look very strong this time around',
    startMs: 0,
    endMs: 2500,
    isFinal: true
  })
  // matching system final lands 800ms later (within the 2.5s hold)
  rec.onResult('system', {
    text: 'The quarterly numbers look very strong this time around.',
    startMs: 100,
    endMs: 2600,
    isFinal: true
  })
  rec.flushPendingMicFinals()
  const rows = getSegments(m.id)
  result(
    'held mic final retracted when system copy arrives late',
    rows.length === 1 && rows[0].channel === 'system',
    `${rows.length} rows: ${rows.map((r) => r.channel).join(', ')}`
  )
}

header('Mixed speech (user talking over remote audio) → both kept')
{
  const m = createMeeting()
  const rec = makeRecorder(m.id)
  rec.onResult('system', {
    text: 'the quarterly numbers look strong across every region',
    startMs: 0,
    endMs: 3000,
    isFinal: true
  })
  rec.onResult('mic', {
    text: 'I think we should ship the feature on friday',
    startMs: 200,
    endMs: 2800,
    isFinal: true
  })
  rec.flushPendingMicFinals()
  const rows = getSegments(m.id)
  result(
    'distinct overlapping speech is not suppressed',
    rows.length === 2,
    `${rows.length} rows`
  )
}

header('Verbatim short duplicate ("yeah exactly") → suppressed as echo')
{
  // Changed 6/11 after Pass A leaked "Called Constantinople.": a 2+-token mic
  // final that token-for-token equals an overlapping system entry is speaker
  // bleed, not the user coincidentally saying the identical phrase in the
  // same two-second window.
  const m = createMeeting()
  const rec = makeRecorder(m.id)
  rec.onResult('system', { text: 'yeah, exactly.', startMs: 0, endMs: 1000, isFinal: true })
  rec.onResult('mic', { text: 'yeah exactly', startMs: 100, endMs: 1100, isFinal: true })
  rec.flushPendingMicFinals()
  const rows = getSegments(m.id)
  result(
    'verbatim short duplicate dropped, system copy kept',
    rows.length === 1 && rows[0].channel === 'system',
    `${rows.length} rows: ${rows.map((r) => r.channel).join(', ')}`
  )
}

header('Lone single-token backchannel ("yeah") → kept')
{
  const m = createMeeting()
  const rec = makeRecorder(m.id)
  rec.onResult('system', { text: 'yeah.', startMs: 0, endMs: 800, isFinal: true })
  rec.onResult('mic', { text: 'yeah', startMs: 100, endMs: 700, isFinal: true })
  rec.flushPendingMicFinals()
  const rows = getSegments(m.id)
  result(
    'single tokens matching only short entries never suppressed',
    rows.length === 2,
    `${rows.length} rows`
  )
}

header('Diarized unique index (COALESCE speaker)')
{
  const m = createMeeting()
  // same (channel, times, text) but different speakers → distinct rows
  insertSegment(m.id, 'system', 'we agree completely', 1000, 2000, 0)
  insertSegment(m.id, 'system', 'we agree completely', 1000, 2000, 1)
  // retransmit with the same speaker → deduped
  insertSegment(m.id, 'system', 'we agree completely', 1000, 2000, 1)
  // NULL-speaker retransmit (mic path) still dedupes despite SQLite NULL rules
  insertSegment(m.id, 'mic', 'noted, thanks everyone', 3000, 4000)
  insertSegment(m.id, 'mic', 'noted, thanks everyone', 3000, 4000)
  const rows = getSegments(m.id)
  const systemRows = rows.filter((r) => r.channel === 'system')
  const micRows = rows.filter((r) => r.channel === 'mic')
  result(
    'distinct speakers kept, same-speaker and NULL-speaker replays deduped',
    systemRows.length === 2 && micRows.length === 1,
    `system=${systemRows.length} (want 2), mic=${micRows.length} (want 1)`
  )
}

console.log('\necho-suppression complete')
