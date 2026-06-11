// Replay of the 2026-06-11 Pass A echo leak (meeting 7d99d6f3) with the exact
// timestamps persisted in the production DB. (Postmortem: that pass ran a
// stale June-10 package with no suppressor at all; this replay pins the
// current logic against the real-world data so it stays fixed.) Every system
// result is observed before the corresponding mic final flushes, so all three
// leaked mic rows must be suppressed here — including the 2-token fragment
// "History books.", caught by the embedded-fragment rule.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/echo-leak-repro.ts
import { createMeeting } from '../../src/main/db/meetings.ts'
import { getSegments } from '../../src/main/db/transcripts.ts'
import { Recorder } from '../../src/main/transcription/recorder.ts'
import { EchoSuppressor } from '../../src/main/transcription/echoSuppressor.ts'
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

header('Pass A replay: all system entries observed before mic flush')
{
  const m = createMeeting()
  const rec = new Recorder() as unknown as TestRecorder
  rec.meetingId = m.id
  rec.startedAt = 0

  const seq: Array<['mic' | 'system', string, number, number]> = [
    ['mic', 'This is Cooper, and this is a test.', 368, 3098],
    ['system', 'His', 3008, 7438],
    ['mic', 'History books.', 4628, 8367.99975585938],
    ['system', 'History books will tell you the Roman Empire fell in the fifth century CE.', 7438, 12348],
    ['mic', 'Will tell you the Roman Empire fell in the fifth century CE.', 8368, 12678.0004882813],
    ['system', 'But this would have come as a great', 12348, 14278.0002441406],
    ['mic', 'But this would have come as a great', 12678, 14497.9997558594]
  ]
  for (const [ch, text, startMs, endMs] of seq) {
    rec.onResult(ch, { text, startMs, endMs, isFinal: true })
  }
  rec.flushPendingMicFinals()

  const rows = getSegments(m.id)
  const micRows = rows.filter((r) => r.channel === 'mic')
  result(
    'only genuine mic speech survives',
    micRows.length === 1 && micRows[0].text.startsWith('This is Cooper'),
    `mic rows: ${micRows.map((r) => JSON.stringify(r.text)).join(', ')}`
  )
}

header('Direct EchoSuppressor checks with the leaked pairs')
{
  const s = new EchoSuppressor()
  s.observeSystem('His', 3008, 7438)
  s.observeSystem('History books will tell you the Roman Empire fell in the fifth century CE.', 7438, 12348)
  s.observeSystem('But this would have come as a great', 12348, 14278.0002441406)

  result(
    '"Will tell you...CE." (12 tokens, full coverage) flagged as echo',
    s.isEcho('Will tell you the Roman Empire fell in the fifth century CE.', 8368, 12678.0004882813)
  )
  result(
    '"But this would have come as a great" (exact dup) flagged as echo',
    s.isEcho('But this would have come as a great', 12678, 14497.9997558594)
  )
  result(
    '"History books." (2-token fragment of a long system entry) flagged as echo',
    s.isEcho('History books.', 4628, 8367.99975585938)
  )
  result(
    'genuine "This is Cooper..." kept',
    !s.isEcho('This is Cooper, and this is a test.', 368, 3098)
  )
}

header('Round 2 (Pass A/B on the rebuilt app): residual fragment leaks')
{
  // Pass A: post-anchor-fix skew was 7ms; system split "Called
  // Constantinople." into its own short entry, and the mic echo matched it
  // verbatim instead of being embedded in a longer one.
  const a = new EchoSuppressor()
  a.observeSystem('moved the capital of the Roman Empire to a new city.', 27863, 30982)
  a.observeSystem('Called Constantinople.', 31263, 32703)
  a.observeSystem('Which he', 32953, 33353)
  result(
    '"Called Constantinople." verbatim echo of equally short entry suppressed',
    a.isEcho('Called Constantinople.', 31270, 32899)
  )
  result(
    '"Ubashi." (garbage mishear, no token match) still passes — needs confidence data',
    !a.isEcho('Ubashi.', 32900, 33559)
  )
  result('"Very interesting." genuine speech kept', !a.isEcho('Very interesting.', 33560, 35500))

  // Pass B: single-token fragments of long system sentences leaked.
  const b = new EchoSuppressor()
  b.observeSystem('special guest, my husband Dan. Hello.', 7235, 10755)
  b.observeSystem('conversation, and millions of you loved this and said that it', 21225, 24985)
  result('"guest." single token embedded in long entry suppressed', b.isEcho('guest.', 7953, 8763))
  result(
    '"conversation" single token embedded in long entry suppressed',
    b.isEcho('conversation', 21043, 22462)
  )
}

header('Fragment rules do not eat genuine backchannels')
{
  const s = new EchoSuppressor()
  s.observeSystem('yeah.', 0, 800)
  s.observeSystem('I think we should ship it on Friday afternoon then.', 2000, 5000)
  result('lone "yeah" vs short "yeah." entry kept', !s.isEcho('yeah', 100, 700))
  result(
    '"sounds good" (tokens absent from system speech) kept',
    !s.isEcho('sounds good', 2500, 3500)
  )
}

console.log('\necho-leak-repro complete')
