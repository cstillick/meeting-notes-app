// Evidence harness for speaker identity: the mic can now carry several voices
// (an in-person lecture), speaker indices must stay stable across a websocket
// reconnect and a re-recording, and a name assigned once must relabel the whole
// note without touching a transcript row or an embedding.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/speaker-roster.ts
import { createMeeting } from '../../src/main/db/meetings.ts'
import { insertSegment, getSegments } from '../../src/main/db/transcripts.ts'
import {
  clearSpeaker,
  mergeSpeakers,
  setSpeakerIsMe,
  setSpeakerName,
  speakerNameMap,
  speakerRoster
} from '../../src/main/db/speakers.ts'
import {
  SYSTEM_PROMPT,
  defaultSpeakerLabel as mainLabel,
  formatTranscript,
  speakerKey as mainKey,
  speakerLabel
} from '../../src/main/enhance/prompt.ts'
import {
  defaultSpeakerLabel as rendererLabel,
  speakerKey as rendererKey
} from '../../src/renderer/src/lib/speakers.ts'
import { CHAT_MEETING_SYSTEM } from '../../src/main/chat/prompt.ts'
import { chunkNote } from '../../src/main/embeddings/lib.ts'
import { reindexMeeting } from '../../src/main/db/search.ts'
import { getDb } from '../../src/main/db/database.ts'
import { attachRecorder } from './_recorder.ts'
import { header, result } from './_util.ts'

type Chan = 'mic' | 'system'
const SHAPES: [Chan, number | null][] = [
  ['mic', null],
  ['system', null],
  ['mic', 0],
  ['mic', 3],
  ['system', 0],
  ['system', 11]
]

header('Main and renderer label helpers agree (the duplication is deliberate)')
{
  // src/main/enhance/prompt.ts must stay importable by the MCP server, which
  // runs under plain node with no path alias, so the renderer keeps a copy.
  // This converts that copy from a hazard into a tested invariant.
  const labelMismatch = SHAPES.filter(([c, s]) => mainLabel(c, s) !== rendererLabel(c, s))
  const keyMismatch = SHAPES.filter(([c, s]) => mainKey(c, s) !== rendererKey(c, s))
  result(
    'defaultSpeakerLabel identical across the copy',
    labelMismatch.length === 0,
    labelMismatch.map(([c, s]) => `${c}:${s}`).join(', ') || 'all 6 shapes'
  )
  result(
    'speakerKey identical across the copy',
    keyMismatch.length === 0,
    keyMismatch.map(([c, s]) => `${c}:${s}`).join(', ') || 'all 6 shapes'
  )
}

header('Fallback labels are byte-identical to the pre-names behaviour')
{
  const cases: [Chan, number | null, string][] = [
    ['mic', null, 'Me'],
    ['system', null, 'Them'],
    ['system', 0, 'Speaker 1'],
    ['system', 4, 'Speaker 5']
  ]
  const wrong = cases.filter(
    ([c, s, want]) => speakerLabel({ channel: c, text: '', startMs: 0, speaker: s }) !== want
  )
  result(
    'Me / Them / Speaker N unchanged with no names map',
    wrong.length === 0,
    wrong.map(([c, s]) => `${c}:${s}`).join(', ') || '4 shapes'
  )
  result(
    'a diarized mic speaker is suffixed so it cannot collide with a system one',
    speakerLabel({ channel: 'mic', text: '', startMs: 0, speaker: 0 }) === 'Speaker 1 (room)' &&
      speakerLabel({ channel: 'system', text: '', startMs: 0, speaker: 0 }) === 'Speaker 1',
    `${mainLabel('mic', 0)} vs ${mainLabel('system', 0)}`
  )
}

header('Diarized mic finals split into one row per speaker')
{
  const m = createMeeting()
  // wantEcho:false is an in-person recording: no system channel exists, so the
  // suppressor has nothing to match and the 3.5s hold is skipped.
  const rec = attachRecorder(m.id, 0, 0, { wantEcho: false, micDiarize: true })
  rec.onResult('mic', {
    text: 'today we are going to cover the fiscal multiplier',
    startMs: 0,
    endMs: 3000,
    isFinal: true,
    speaker: 0,
    speakerEpoch: 0
  })
  rec.onResult('mic', {
    text: 'does that hold when interest rates are at the lower bound',
    startMs: 3200,
    endMs: 6000,
    isFinal: true,
    speaker: 1,
    speakerEpoch: 0
  })
  const rows = getSegments(m.id)
  const speakers = rows.map((r) => r.speaker)
  result(
    'two mic rows with distinct non-null speakers',
    rows.length === 2 && speakers[0] !== null && speakers[1] !== null && speakers[0] !== speakers[1],
    `${rows.length} rows, speakers ${JSON.stringify(speakers)}`
  )
  result(
    'in-person finals commit immediately, with no mic-final hold',
    rows.length === 2,
    'persisted before any flushPendingMicFinals() call'
  )
}

header('A retransmitted final whose speaker index flickered is still one row')
{
  const m = createMeeting()
  const rec = attachRecorder(m.id, 0, 0, { wantEcho: false, micDiarize: true })
  const base = {
    text: 'the multiplier is larger when output is below potential',
    startMs: 1000,
    endMs: 4000,
    isFinal: true as const,
    speakerEpoch: 0
  }
  rec.onResult('mic', { ...base, speaker: 0 })
  // idx_segments_unique keys on COALESCE(speaker,-1), so the replay below is a
  // DIFFERENT key and INSERT OR IGNORE would happily accept it — this is the
  // corruption path diarizing the mic opens, and the only guard is commitFinal's
  // segmentExists() check.
  rec.onResult('mic', { ...base, speaker: 1 })
  const rows = getSegments(m.id)
  result(
    'flickered retransmit deduped on text + time',
    rows.length === 1,
    `${rows.length} rows: ${rows.map((r) => `sp${r.speaker}`).join(', ')}`
  )
}

header('Speaker indices survive a reconnect and a re-recording')
{
  const m = createMeeting()
  const rec = attachRecorder(m.id, 0, 0, { wantEcho: false, micDiarize: true })
  // Deepgram restarts numbering at 0 on the new connection, so raw index 0 in
  // epoch 1 is a different human from raw index 0 in epoch 0. Splitting is the
  // safe error: the user can merge two chips, but cannot un-merge two people
  // whose words were already filed under one name.
  rec.onResult('mic', {
    text: 'first speaker before the drop',
    startMs: 0,
    endMs: 2000,
    isFinal: true,
    speaker: 0,
    speakerEpoch: 0
  })
  rec.onResult('mic', {
    text: 'a different voice after the reconnect',
    startMs: 4000,
    endMs: 6000,
    isFinal: true,
    speaker: 0,
    speakerEpoch: 1
  })
  const rows = getSegments(m.id)
  result(
    'same raw index in two epochs allocates two stable indices',
    rows.length === 2 && rows[0].speaker !== rows[1].speaker,
    `speakers ${JSON.stringify(rows.map((r) => r.speaker))}`
  )
}

header('A second recording on the same note cannot reuse the first session speakers')
{
  const m = createMeeting()
  insertSegment(m.id, 'mic', 'from the first session', 0, 2000, 4)
  // A fresh Recorder is a fresh session, exactly as re-pressing Record is.
  const rec = attachRecorder(m.id, 0, 10_000, { wantEcho: false, micDiarize: true })
  rec.onResult('mic', {
    text: 'from the second session',
    startMs: 0,
    endMs: 2000,
    isFinal: true,
    speaker: 0,
    speakerEpoch: 0
  })
  const rows = getSegments(m.id).filter((r) => r.text === 'from the second session')
  result(
    'allocator seeds past MAX(speaker) on the note',
    rows.length === 1 && rows[0].speaker === 5,
    `speaker ${rows[0]?.speaker} (expected 5, past the stored 4)`
  )
}

header('Interim results never allocate a speaker index')
{
  // An interim's speaker comes from the LAST WORD of a partial result — the
  // value groupWordsBySpeaker() exists to smooth on finals. Letting it allocate
  // burns a stable index on a phantom nobody ever says, permanently shifting
  // every real speaker: a two-person lecture labelled "Speaker 3"/"Speaker 4".
  const m = createMeeting()
  const rec = attachRecorder(m.id, 0, 0, { wantEcho: false, micDiarize: true })
  // Two interims whose trailing word flickered onto raw indices no final uses.
  rec.onResult('mic', {
    text: 'today we will cover',
    startMs: 0,
    endMs: 1500,
    isFinal: false,
    speaker: 2,
    speakerEpoch: 0
  })
  rec.onResult('mic', {
    text: 'today we will cover the multiplier',
    startMs: 0,
    endMs: 2500,
    isFinal: false,
    speaker: 3,
    speakerEpoch: 0
  })
  rec.onResult('mic', {
    text: 'today we will cover the multiplier',
    startMs: 0,
    endMs: 3000,
    isFinal: true,
    speaker: 0,
    speakerEpoch: 0
  })
  rec.onResult('mic', {
    text: 'does that hold at the lower bound',
    startMs: 3200,
    endMs: 5000,
    isFinal: true,
    speaker: 1,
    speakerEpoch: 0
  })
  const rows = getSegments(m.id)
  result(
    'a two-person lecture is numbered from 0, not shifted past the phantoms',
    JSON.stringify(rows.map((r) => r.speaker)) === '[0,1]',
    `speakers ${JSON.stringify(rows.map((r) => r.speaker))}`
  )
  result(
    'the roster shows exactly two voices, labelled 1 and 2',
    speakerRoster(m.id)
      .map((r) => r.label)
      .join(' | ') === 'Speaker 1 (room) | Speaker 2 (room)',
    speakerRoster(m.id)
      .map((r) => r.label)
      .join(' | ')
  )
}

header('Roster: default labels, naming, is-me, merge')
{
  const m = createMeeting()
  insertSegment(m.id, 'mic', 'i am taking notes', 0, 1000, null)
  insertSegment(m.id, 'system', 'first remote voice', 1200, 2000, 0)
  insertSegment(m.id, 'system', 'second remote voice', 2200, 3000, 1)

  const roster = speakerRoster(m.id)
  result(
    'every distinct voice appears, in first-appearance order, with generated labels',
    roster.map((r) => r.label).join(' | ') === 'Me | Speaker 1 | Speaker 2',
    roster.map((r) => r.label).join(' | ')
  )
  result('no names assigned yet → empty map', speakerNameMap(m.id).size === 0, 'size 0')

  const named = setSpeakerName(m.id, 'system', 0, 'Dana')
  result(
    'naming relabels that voice and only that voice',
    named.map((r) => r.label).join(' | ') === 'Me | Dana | Speaker 2',
    named.map((r) => r.label).join(' | ')
  )
  result(
    'the names map resolves through speakerLabel',
    speakerLabel({ channel: 'system', text: '', startMs: 0, speaker: 0 }, speakerNameMap(m.id)) ===
      'Dana',
    'Dana'
  )
  result(
    'a name never reaches a transcript row',
    getSegments(m.id).every((r) => !r.text.includes('Dana')),
    'no segment text touched'
  )

  setSpeakerIsMe(m.id, 'system', 0)
  const afterSecondMe = setSpeakerIsMe(m.id, 'system', 1)
  result(
    'exactly one voice is "me" after two assignments',
    meIdentities(afterSecondMe).length === 1 &&
      afterSecondMe.find((r) => r.isMe)?.speaker === 1,
    `${meIdentities(afterSecondMe).length} identities marked, on speaker ${afterSecondMe.find((r) => r.isMe)?.speaker}`
  )

  const before = speakerRoster(m.id)
  const from = before.find((r) => r.speaker === 1)?.identityId
  const into = before.find((r) => r.speaker === 0)?.identityId
  const segmentsBefore = JSON.stringify(getSegments(m.id))
  const merged = mergeSpeakers(m.id, from!, into!)
  result(
    'merging two voices collapses them onto one identity',
    merged.filter((r) => r.channel === 'system').every((r) => r.label === 'Dana'),
    merged.map((r) => r.label).join(' | ')
  )
  result(
    'a merge rewrites no transcript row',
    JSON.stringify(getSegments(m.id)) === segmentsBefore,
    'segments byte-identical'
  )

  const cleared = clearSpeaker(m.id, 'system', 0)
  result(
    'clearing one key falls back to its generated label, leaving the merged one named',
    cleared.find((r) => r.speaker === 0)?.label === 'Speaker 1' &&
      cleared.find((r) => r.speaker === 1)?.label === 'Dana',
    cleared.map((r) => r.label).join(' | ')
  )
}

/** Distinct identities carrying is_me. Several roster ROWS can share one — that
 *  is exactly what a merge produces — so counting rows would double-count. */
function meIdentities(roster: { isMe: boolean; identityId: number | null }[]): number[] {
  return [...new Set(roster.filter((r) => r.isMe).map((r) => r.identityId))].filter(
    (id): id is number => id !== null
  )
}

header('Merging carries the absorbed identity forward')
{
  // A merge target must already HAVE an identity — the UI's dropdown only
  // offers identities, so `into` is always a voice someone has already named or
  // marked. What must not happen is the absorbed voice's attributes vanishing.
  const m = createMeeting()
  insertSegment(m.id, 'system', 'the note-taker speaking', 0, 1000, 0)
  insertSegment(m.id, 'system', 'the same person after a reconnect', 2000, 3000, 1)
  setSpeakerName(m.id, 'system', 0, 'Dana')
  setSpeakerIsMe(m.id, 'system', 0)
  // Give the target an identity with no name of its own.
  setSpeakerIsMe(m.id, 'system', 1)
  setSpeakerIsMe(m.id, 'system', 0)
  const before = speakerRoster(m.id)
  const from = before.find((r) => r.speaker === 0)!.identityId!
  const into = before.find((r) => r.speaker === 1)!.identityId!
  const merged = mergeSpeakers(m.id, from, into)
  result(
    'the name survives being merged into an unnamed identity',
    merged.every((r) => r.label === 'Dana'),
    merged.map((r) => r.label).join(' | ')
  )
  result(
    'the is_me flag survives being merged away',
    meIdentities(merged).length === 1,
    `${meIdentities(merged).length} identities marked, on ${merged.filter((r) => r.isMe).length} keys`
  )
}

header('Merging into a NAMED identity keeps the target name and adopts is_me')
{
  const m = createMeeting()
  insertSegment(m.id, 'system', 'voice one', 0, 1000, 0)
  insertSegment(m.id, 'system', 'voice two', 2000, 3000, 1)
  setSpeakerName(m.id, 'system', 0, 'Dana')
  setSpeakerIsMe(m.id, 'system', 0)
  setSpeakerName(m.id, 'system', 1, 'Bob')
  const before = speakerRoster(m.id)
  const merged = mergeSpeakers(
    m.id,
    before.find((r) => r.speaker === 0)!.identityId!,
    before.find((r) => r.speaker === 1)!.identityId!
  )
  result(
    "the target's own name wins over the absorbed one",
    merged.every((r) => r.label === 'Bob'),
    merged.map((r) => r.label).join(' | ')
  )
  result(
    'the note still has exactly one note-taker after the merge',
    meIdentities(merged).length === 1,
    `${meIdentities(merged).length} identities marked`
  )
}

header('Palette colours do not collide after an identity is deleted')
{
  const m = createMeeting()
  for (let i = 0; i < 3; i++) {
    insertSegment(m.id, 'system', `voice ${i}`, i * 1000, i * 1000 + 500, i)
  }
  setSpeakerName(m.id, 'system', 0, 'A')
  setSpeakerName(m.id, 'system', 1, 'B')
  // Deleting the middle identity used to drop the COUNT the next colour was
  // taken from, handing the new name a colour already on screen.
  clearSpeaker(m.id, 'system', 1)
  setSpeakerName(m.id, 'system', 2, 'C')
  const named = speakerRoster(m.id).filter((r) => r.name !== null)
  const colors = named.map((r) => r.colorIndex)
  result(
    'two named speakers never share a palette slot',
    new Set(colors).size === colors.length,
    `${named.map((r) => `${r.name}=${r.colorIndex}`).join(', ')}`
  )
}

header('Renaming is free: chunks unchanged, FTS gains the name')
{
  const m = createMeeting()
  insertSegment(m.id, 'system', 'the fiscal multiplier depends on slack', 0, 3000, 0)
  const lines = getSegments(m.id).map((s) => ({
    channel: s.channel,
    text: s.text,
    startMs: s.startMs,
    speaker: s.speaker
  }))
  const chunksBefore = JSON.stringify(chunkNote([], lines))

  setSpeakerName(m.id, 'system', 0, 'Professor Alvarez')
  reindexMeeting(m.id)

  const chunksAfter = JSON.stringify(chunkNote([], lines))
  result(
    'chunk text is byte-identical after a rename (no re-embedding)',
    chunksBefore === chunksAfter,
    'the chunker is never given the names map'
  )
  const row = getDb()
    .prepare(
      'SELECT body FROM search_fts WHERE rowid = (SELECT fts_rowid FROM meetings WHERE id = ?)'
    )
    .get(m.id) as { body: string } | undefined
  result(
    'the FTS body carries the assigned name, so name search works',
    !!row?.body.includes('Professor Alvarez'),
    row?.body.includes('Professor Alvarez') ? 'found' : `body: ${row?.body}`
  )
}

header('Prompt formatting honours names, and falls back without them')
{
  const lines = [
    { channel: 'system' as const, text: 'welcome to the lecture', startMs: 0, speaker: 0 },
    { channel: 'mic' as const, text: 'a question from the room', startMs: 2000, speaker: 1 }
  ]
  result(
    'no names → the exact pre-existing format',
    formatTranscript(lines) ===
      '[0:00] [Speaker 1] welcome to the lecture\n[0:02] [Speaker 2 (room)] a question from the room',
    formatTranscript(lines)
  )
  const names = new Map([
    ['system:0', 'Prof. Chen'],
    ['mic:1', 'Classmate']
  ])
  result(
    'with names → assigned labels, same shape',
    formatTranscript(lines, names) ===
      '[0:00] [Prof. Chen] welcome to the lecture\n[0:02] [Classmate] a question from the room',
    formatTranscript(lines, names)
  )
}

header('No prompt still tells the model that "Me" means the user and others are remote')
{
  // Prose has no type checker, and eight surfaces have to agree. A lecture
  // transcript that tells Claude five in-room students were remote participants
  // is a silently wrong answer, not a crash.
  const stale = ['"Me" is the user', 'other speakers came from system audio']
  const offenders: string[] = []
  for (const [name, text] of [
    ['SYSTEM_PROMPT', SYSTEM_PROMPT],
    ['CHAT_MEETING_SYSTEM', CHAT_MEETING_SYSTEM]
  ] as const) {
    for (const phrase of stale) if (text.includes(phrase)) offenders.push(`${name}: "${phrase}"`)
  }
  result('enhance + chat prompts carry no stale claim', offenders.length === 0, offenders.join('; '))
  const missing = ([
    ['SYSTEM_PROMPT', SYSTEM_PROMPT, /no note-taker voice/i],
    ['CHAT_MEETING_SYSTEM', CHAT_MEETING_SYSTEM, /no "Me" at all/i]
  ] as const).filter(([, text, re]) => !re.test(text))
  result(
    'both prompts state that a recording may have no note-taker voice',
    missing.length === 0,
    missing.map(([n]) => n).join(', ') || 'lecture/import framing present in both'
  )
}
