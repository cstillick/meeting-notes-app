// MCP stress: the read-only note server end to end.
//
// Two halves, and the second one is the point. The first calls the tool bodies
// directly against a seeded library (ranking, scoping, paging, truncation). The
// second spawns src/mcp/server.ts with *plain* node — no --import hooks, no
// electron stub, exactly how Claude Desktop launches it — and runs a real
// JSON-RPC handshake over stdio. That is the only check that catches the
// server's one cross-boundary import (../main/enhance/prompt.ts) growing a
// runtime dependency on `electron` or `@shared/*`, which would resolve fine
// under the stress hooks and fail on the user's machine.
//
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/mcp-tools.ts
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDb, closeDb } from '../../src/main/db/database.ts'
import {
  createMeeting,
  updateTitle,
  saveNotes,
  saveEnhanced,
  setStarted,
  setEnded
} from '../../src/main/db/meetings.ts'
import { createFolder, setMeetingFolder } from '../../src/main/db/folders.ts'
import { insertSegment } from '../../src/main/db/transcripts.ts'
import { reindexMeeting } from '../../src/main/db/search.ts'
import { openLibrary, resolveDbPath, type Library } from '../../src/mcp/db.ts'
import {
  getNoteTool,
  getNotesTool,
  getTranscriptTool,
  libraryOverview,
  listFoldersTool,
  listNotesTool,
  outlineTool,
  searchNotesTool,
  topicsTool,
  searchTranscriptTool
} from '../../src/mcp/tools.ts'
import { header, result } from './_util.ts'

const dir = process.env.STRESS_USERDATA_DIR!
const dbPath = join(dir, 'granola-clone.db')
// fileURLToPath, not URL.pathname: this repo lives in a directory with a space
// in its name, and a percent-encoded path is not a path.
const serverPath = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))

// ---------------------------------------------------------------------------
// Seed a library through the real app code paths
// ---------------------------------------------------------------------------

function doc(...paragraphs: string[]): string {
  return JSON.stringify({
    type: 'doc',
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }]
    }))
  })
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const product = createFolder('Product')
const personal = createFolder('Personal')

/** createMeeting stamps created_at with Date.now(), so five notes seeded in one
 *  tick tie — and "newest first" over a tie is whatever order SQLite feels
 *  like. Space them out so ordering and date filters are actually testable. */
function backdate(id: string, ms: number): void {
  getDb().prepare('UPDATE meetings SET created_at = ? WHERE id = ?').run(ms, id)
}

// A: the fully-populated note — rough notes, enhanced notes carrying the ⟦U⟧
// sentinels the editor writes, and a three-line two-speaker transcript.
const a = createMeeting().id
updateTitle(a, 'Pricing sync')
setMeetingFolder(a, product.id)
setStarted(a, Date.now() - 2 * HOUR)
setEnded(a, Date.now() - 2 * HOUR + 30 * 60_000)
saveNotes(a, doc('renewal terms', 'discount ask'))
insertSegment(a, 'mic', 'I think we can do twelve percent', 1_000, 3_000)
insertSegment(a, 'system', 'Acme needs eighteen months on the renewal', 5_000, 8_000, 0)
insertSegment(a, 'system', 'What about the migration timeline', 9_000, 11_000, 1)
saveEnhanced(
  a,
  '{}',
  [
    '# Pricing sync',
    '',
    '- ⟦U⟧renewal terms⟦/U⟧ — Acme wants 18 months',
    '- ⟦U⟧discount ask⟦/U⟧ — capped at twelve percent, approved by finance',
    '',
    '## Decisions',
    '- Eighteen-month term accepted in principle, subject to legal review.',
    '- Discount holds only if the migration completes inside the first quarter.',
    '',
    '## Action items',
    '- Send the revised order form before Friday.',
    '- Confirm the migration timeline with the platform team.',
    '- Circulate the redlines once legal has passed on the term length.',
    '',
    '## Meeting outline',
    '- Renewal terms',
    '  - Term length',
    '  - Discount ceiling',
    '- Migration',
    '  - Timeline risk',
    '',
    // A half-emitted marker, which 23 of the author's 102 enhanced notes carry.
    // Stripping only the two well-formed forms leaves this residue behind.
    '- ⟦/U⟦ stray closer and a lone ⟧ bracket'
  ].join('\n')
)
backdate(a, Date.now() - 2 * HOUR)
reindexMeeting(a)

const b = createMeeting().id
updateTitle(b, 'Infra review')
setMeetingFolder(b, product.id)
setStarted(b, Date.now() - 26 * HOUR)
setEnded(b, Date.now() - 26 * HOUR + 45 * 60_000)
insertSegment(b, 'mic', 'the failover took ninety seconds', 2_000, 4_000)
saveEnhanced(b, '{}', '# Infra review\n\n- Postgres failover rehearsed')
backdate(b, Date.now() - 26 * HOUR)
reindexMeeting(b)

const c = createMeeting().id
updateTitle(c, 'Dentist appointment')
saveNotes(c, doc('call back about the crown'))
backdate(c, Date.now() - 3 * DAY)
reindexMeeting(c)

const d = createMeeting().id
updateTitle(d, 'Weekend plans')
setMeetingFolder(d, personal.id)
saveNotes(d, doc('camping gear list'))
backdate(d, Date.now() - 4 * DAY)
reindexMeeting(d)

// E keeps its empty title, so listings have to render the "Untitled" fallback.
const e = createMeeting().id
saveNotes(e, doc('scratch thoughts about kubernetes'))
backdate(e, Date.now() - 5 * DAY)
reindexMeeting(e)

// F: the wall clock lies. Re-recording an existing note overwrites started_at
// with the second session's time while the transcript keeps appending on the
// original timeline, leaving a 1.4-second clock span over half an hour of
// audio. Three notes in the author's real library are in this state, and the
// old duration() reported them as "0 min" next to hundreds of spoken lines.
const f = createMeeting().id
updateTitle(f, 'Re-recorded planning session')
insertSegment(f, 'mic', 'picking up where we left off', 2_100_000, 2_103_000)
const reStart = Date.now() - 6 * DAY
getDb()
  .prepare("UPDATE meetings SET started_at = ?, ended_at = ?, status = 'recorded' WHERE id = ?")
  .run(reStart, reStart + 1_372, f)
backdate(f, reStart)
reindexMeeting(f)

// G: fixtures for word-boundary matching and timestamp ties.
const g = createMeeting().id
updateTitle(g, 'Model evaluation review')
// "said", "constraint" and "gain" all contain the substring "ai"; only the
// second line actually says the word. Substring matching returned all of them.
insertSegment(g, 'mic', 'she said the constraint would gain us nothing', 1_000, 3_000)
insertSegment(g, 'system', 'the AI model shipped on Tuesday', 4_000, 6_000, 0)
// Both channels opening in the same millisecond — the tie that used to collapse
// two distinct hits onto whichever line came first.
insertSegment(g, 'mic', 'budget approved for the pilot', 7_000, 9_000)
insertSegment(g, 'system', 'budget approved by finance too', 7_000, 9_500, 1)
backdate(g, Date.now() - 7 * DAY)
reindexMeeting(g)

// H-J: a numbered syllabus, the shape a course library takes. The "1.2.x" note
// is the trap: a substring filter for "2." matches it too, so topic selection
// has to anchor at the start of the title.
const course = createFolder('Course')
const numbered = ['1.2.1 Elasticity intro', '2.1.1 Marginal product', '2.2.1 Cost curves']
const numberedIds = numbered.map((t, i) => {
  const id = createMeeting().id
  updateTitle(id, t)
  setMeetingFolder(id, course.id)
  saveEnhanced(id, '{}', `# ${t}\n\nBody text for ${t}.`)
  backdate(id, Date.now() - (10 + i) * DAY)
  reindexMeeting(id)
  return id
})

// K: numeric ordering — lexicographic sort puts 2.2.10 before 2.2.4.
const k = createMeeting().id
updateTitle(k, '2.2.10 Later section')
setMeetingFolder(k, course.id)
saveEnhanced(k, '{}', '# 2.2.10\n\nLater section body.')
backdate(k, Date.now() - 13 * DAY)
reindexMeeting(k)

// L: a numbered note deliberately left UNFILED. Eight of the author's topic-2
// notes are in this state, so a folder-scoped topic query silently loses them.
const l = createMeeting().id
updateTitle(l, '2.9.9 Unfiled reading assignment')
saveEnhanced(l, '{}', '# 2.9.9\n\nUnfiled but part of topic 2.')
backdate(l, Date.now() - 14 * DAY)
reindexMeeting(l)

// M: big enhanced body plus a real transcript, for budget accounting.
const m = createMeeting().id
updateTitle(m, 'Long recorded session')
saveEnhanced(m, '{}', `# Long\n\n${'padding sentence about supply and demand. '.repeat(400)}`)
for (let i = 0; i < 30; i++) {
  insertSegment(m, 'mic', `spoken line number ${i} about equilibrium`, i * 2_000, i * 2_000 + 1_500)
}
backdate(m, Date.now() - 15 * DAY)
reindexMeeting(m)

// Counts the assertions below quote back. Named so that seeding another note is
// a one-line change instead of a hunt through hard-coded strings.
const EXPECT_NOTES = 13
const EXPECT_WITH_TRANSCRIPT = 5
const EXPECT_UNFILED = 6

// ---------------------------------------------------------------------------
// Tool bodies, against a library opened while the writer is still connected
// (the app-is-running case: a hot WAL and a second reader).
// ---------------------------------------------------------------------------

getDb() // keep the writer open
const lib: Library = openLibrary(dbPath)

header('Open + safety rails')
result('opens the seeded library', lib.path === dbPath, lib.mode)
result('detects the folders schema', lib.hasFolders)
result(
  'reads data committed by a still-open writer',
  libraryOverview(lib).includes(`${EXPECT_NOTES} notes`),
  libraryOverview(lib).split('\n')[2]
)
let wrote = false
try {
  lib.db.prepare("UPDATE meetings SET title = 'hijacked' WHERE id = ?").run(a)
  wrote = true
} catch {
  wrote = false
}
result('rejects writes through the served handle', !wrote)
result(
  'GRANOLA_DB_PATH pins path resolution to the sandbox',
  ((): boolean => {
    process.env.GRANOLA_DB_PATH = dbPath
    return resolveDbPath() === dbPath
  })()
)

header('Overview and folders')
const ov = libraryOverview(lib)
result('overview counts transcripts', ov.includes(`${EXPECT_WITH_TRANSCRIPT} notes have a transcript`), ov.split('\n')[3])
result('overview counts folders', ov.includes('3 folders'))
const folders = listFoldersTool(lib)
result('folders list counts per folder', folders.includes('**Product** — 2 notes'))
result('folders list counts unfiled', folders.includes(`**(unfiled)** — ${EXPECT_UNFILED} notes`))

header('list_notes')
const listed = listNotesTool(lib, { limit: 2, offset: 0 })
result('reports the full total while paging', listed.includes(`Showing 1–2 of ${EXPECT_NOTES} notes`))
result(
  'newest note first',
  listed.indexOf('Pricing sync') < listed.indexOf('Infra review') &&
    !listed.includes('Weekend plans'),
  'A then B'
)
const page2 = listNotesTool(lib, { limit: 2, offset: 2 })
result('offset pages forward', page2.includes(`Showing 3–4 of ${EXPECT_NOTES} notes`))
result(
  'renders the empty-title fallback',
  listNotesTool(lib, { limit: 10, offset: 0 }).includes('**Untitled note**')
)
const inFolder = listNotesTool(lib, { limit: 10, offset: 0, folder: 'Product' })
result(
  'folder scope excludes other folders',
  inFolder.includes('Pricing sync') &&
    inFolder.includes('Infra review') &&
    !inFolder.includes('Weekend plans')
)
result(
  'folder scope matches case-insensitively',
  listNotesTool(lib, { limit: 10, offset: 0, folder: 'product' }).includes('Pricing sync')
)
const unfiled = listNotesTool(lib, { limit: 10, offset: 0, folder: 'unfiled' })
result(
  'unfiled scope returns only unfiled notes',
  unfiled.includes('Dentist appointment') && !unfiled.includes('Pricing sync')
)
let folderErr = ''
try {
  listNotesTool(lib, { limit: 10, offset: 0, folder: 'Nonexistent' })
} catch (err) {
  folderErr = (err as Error).message
}
result(
  'unknown folder errors with the real folder names',
  folderErr.includes('"Product"') && folderErr.includes('"Personal"'),
  folderErr.slice(0, 60)
)
result(
  'status filter narrows to drafts',
  !listNotesTool(lib, { limit: 10, offset: 0, status: 'draft' }).includes('Pricing sync')
)
const recent = listNotesTool(lib, {
  limit: 10,
  offset: 0,
  after: new Date(Date.now() - 3 * HOUR).toISOString()
})
result(
  'date bounds keep the newer note and drop the older',
  recent.includes('Pricing sync') && !recent.includes('Infra review')
)
result(
  'a bare YYYY-MM-DD before-bound covers that whole day',
  listNotesTool(lib, {
    limit: 10,
    offset: 0,
    before: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10)
  }).includes('Dentist appointment')
)

header('Honest reporting of what was not read')
const tight = getNotesTool(lib, {
  note_ids: [m.slice(0, 8)],
  include: ['enhanced_notes', 'transcript'],
  max_chars: 2_000
})
result(
  'a starved transcript is never reported as absent',
  !tight.includes('(no transcript recorded)'),
  'the note has 30 segments'
)
result('the shortfall is stated as a budget problem', tight.includes('NOT SHOWN') || tight.includes('not shown'))
result('get_notes totals what it withheld', /withheld/.test(tight), tight.split('\n')[0])
const roomy = getNotesTool(lib, {
  note_ids: [m.slice(0, 8)],
  include: ['transcript'],
  max_chars: 60_000
})
result('with room, the transcript is actually present', roomy.includes('equilibrium'))
const trulyEmpty = getNotesTool(lib, {
  note_ids: [c.slice(0, 8)],
  include: ['transcript'],
  max_chars: 60_000
})
result(
  'a genuinely empty transcript still says so',
  trulyEmpty.includes('(no transcript recorded)'),
  'absence and starvation are distinguishable'
)
const mixed = getNotesTool(lib, {
  note_ids: [m.slice(0, 8), numberedIds[0].slice(0, 8)],
  include: ['enhanced_notes'],
  max_chars: 4_000
})
result(
  'budget goes where the content is, not split evenly',
  mixed.includes('Body text for 1.2.1 Elasticity intro'),
  'the small note is complete despite the large one being starved'
)

header('Topic grouping')
const topics = topicsTool(lib, {})
result('topics groups by the leading title number', topics.includes('2.*'))
result(
  'topics counts a group across folders, including unfiled',
  /2\.\*.*Course/.test(topics) && /2\.\*.*unfiled/.test(topics),
  topics.split('\n').find((x) => x.startsWith('2.')) ?? ''
)

header('Outline and batch reading')
const out = outlineTool(lib, { folder: 'Course', order: 'title', limit: 50 })
result('outline lists every title in the folder', out.includes('4 notes') && out.includes('2.2.1 Cost curves'))
result('outline orders a numbered syllabus by title', out.indexOf('1.2.1') < out.indexOf('2.1.1'))
const anchored = outlineTool(lib, {
  folder: 'Course',
  title_starts_with: '2.',
  order: 'title',
  limit: 50
})
result(
  'title_starts_with anchors, excluding 1.2.1',
  anchored.includes('2.1.1') && anchored.includes('2.2.1') && !anchored.includes('1.2.1'),
  anchored.split('\n')[0]
)
const loose = outlineTool(lib, { folder: 'Course', title_contains: '2.', order: 'title', limit: 50 })
result(
  'title_contains is the looser operator, and demonstrably so',
  loose.includes('1.2.1'),
  'substring also matches 1.2.1 — why the prefix filter exists'
)
const batch = getNotesTool(lib, {
  note_ids: numberedIds.slice(1).map((id) => id.slice(0, 8)),
  include: ['enhanced_notes'],
  max_chars: 20_000
})
result('get_notes reads several notes in one call', batch.includes('Read 2 notes'))
result(
  'get_notes resolves the short ids outline prints',
  batch.includes('2.1.1') && batch.includes('2.2.1')
)
const starved = getNotesTool(lib, {
  note_ids: numberedIds.map((id) => id.slice(0, 8)),
  include: ['enhanced_notes'],
  max_chars: 2_000
})
result(
  'get_notes accounts for every character it withheld',
  starved.includes('withheld') || starved.includes('nothing withheld'),
  starved.split('\n')[0]
)

header('Counting and truncation honesty')
const capped = searchNotesTool(lib, { query: 'renewal failover', limit: 1 })
result(
  'search reports the true match count, not the page size',
  capped.includes('2 notes matched') && capped.includes('showing 1'),
  capped.split('\n')[0]
)
result('search discloses the notes it did not show', capped.includes('1 more matching notes not shown'))
result(
  'paging past the end explains itself instead of "Showing 8–7 of 7"',
  listNotesTool(lib, { limit: 5, offset: 99 }).includes('past the end')
)

header('Word-boundary transcript matching')
const ai = searchTranscriptTool(lib, { query: 'ai', limit: 20, context_lines: 0 })
result(
  'a short term matches whole words, not substrings',
  ai.includes('AI model shipped') && !ai.includes('would gain us nothing'),
  ai.split('\n')[0]
)
result('the short-term match count excludes the substring noise', ai.includes('1 spoken lines match'))
result(
  'terms longer than 3 characters still match inside words',
  searchTranscriptTool(lib, { query: 'approv', limit: 5, context_lines: 0 }).includes(
    'budget approved'
  ),
  'approv → approved'
)
const tied = searchTranscriptTool(lib, { query: 'budget', limit: 10, context_lines: 0, note_id: g })
result(
  'segments sharing a start_ms both survive',
  tied.includes('for the pilot') && tied.includes('by finance too'),
  tied.split('\n')[0]
)
result(
  'and neither is printed twice',
  (tied.match(/for the pilot/g) || []).length === 1 &&
    (tied.match(/by finance too/g) || []).length === 1
)
result(
  'a pasted paragraph is capped rather than crashing SQLite',
  ((): boolean => {
    const many = Array.from({ length: 400 }, (_, i) => `term${i}`).join(' ')
    const out = searchTranscriptTool(lib, { query: many, limit: 5, context_lines: 0 })
    return out.includes('ignored') && !out.toLowerCase().includes('expression tree')
  })()
)

header('Argument handling')
let emptyId = ''
try {
  getNoteTool(lib, { note_id: '   ', include: ['enhanced_notes'], max_chars: 1000 })
} catch (err) {
  emptyId = (err as Error).message
}
result(
  'a blank note_id is rejected, not answered with the newest notes',
  emptyId.includes('empty') && !emptyId.includes('Pricing sync'),
  emptyId.slice(0, 50)
)
let blankFolder = ''
try {
  listNotesTool(lib, { limit: 5, offset: 0, folder: '   ' })
} catch (err) {
  blankFolder = (err as Error).message
}
result('a blank folder errors rather than silently searching everything', blankFolder.includes('No folder matching'))
result(
  'a 3-character id prefix is honoured, not dismissed as unknown',
  ((): boolean => {
    // Either it resolves, or it is genuinely ambiguous across seeded uuids —
    // both are correct. What must not happen is "No note with id", which is
    // what the old 6-character gate produced.
    try {
      return getNoteTool(lib, {
        note_id: a.slice(0, 3),
        include: ['enhanced_notes'],
        max_chars: 800
      }).includes('Acme')
    } catch (err) {
      return (err as Error).message.includes('matches')
    }
  })()
)
const tinyTranscript = getNoteTool(lib, { note_id: a, include: ['transcript'], max_chars: 60 })
result(
  'max_chars bounds the transcript section too',
  tinyTranscript.length < 600 && /budget|not shown/i.test(tinyTranscript),
  `${tinyTranscript.length} chars`
)

header('Scope honesty')
const scopedOutline = outlineTool(lib, {
  folder: 'Course',
  title_starts_with: '2.',
  order: 'title',
  limit: 50
})
result(
  'a folder-scoped topic query names the notes it excluded',
  scopedOutline.includes('OUTSIDE folder'),
  '2.9.9 is unfiled'
)
result(
  'dropping the folder picks the unfiled one up',
  outlineTool(lib, { title_starts_with: '2.', order: 'title', limit: 50 }).includes('2.9.9')
)
result(
  'numeric ordering, not lexicographic',
  ((): boolean => {
    const o = outlineTool(lib, { title_starts_with: '2.2', order: 'title', limit: 50 })
    return o.indexOf('2.2.1 ') < o.indexOf('2.2.10')
  })(),
  '2.2.1 before 2.2.10'
)
const titleMiss = searchNotesTool(lib, {
  query: 'elasticity',
  limit: 5,
  title_starts_with: '9.'
})
result(
  'search_notes honours title_starts_with instead of ignoring it',
  titleMiss.includes('No notes') && titleMiss.includes('9.'),
  titleMiss.split('\n')[0].slice(0, 90)
)

header('Title-aware ranking')
result(
  'a bare digit is a real term, so topic 2 and topic 3 differ',
  searchNotesTool(lib, { query: 'topic 2', limit: 5 }) !==
    searchNotesTool(lib, { query: 'topic 3', limit: 5 })
)
result(
  'a spelled-out number also matches its digit',
  searchNotesTool(lib, { query: 'topic two', limit: 5, folder: 'Course' }).includes('2.'),
  'two -> 2'
)
result(
  'a title match outranks a body-only mention',
  ((): boolean => {
    const r = searchNotesTool(lib, { query: 'elasticity', limit: 5 })
    return r.indexOf('1.2.1 Elasticity intro') < 400
  })(),
  'title-weighted bm25'
)
result(
  'list_notes accepts the same title filters',
  listNotesTool(lib, { limit: 10, offset: 0, title_starts_with: '2.' }).includes('2.1.1') &&
    !listNotesTool(lib, { limit: 10, offset: 0, title_starts_with: '2.' }).includes('1.2.1')
)

header('Duration reporting')
const fLine = listNotesTool(lib, { limit: 10, offset: 0 })
  .split('\n\n')
  .find((b) => b.includes('Re-recorded planning session'))!
result(
  'a lying wall clock does not report a 35-minute meeting as 0 min',
  fLine.includes('35 min'),
  fLine.split('\n')[2]
)
result('the transcript-derived duration never shows as 0 min', !fLine.includes('0 min'))
const aLine = listNotesTool(lib, { limit: 10, offset: 0 })
  .split('\n\n')
  .find((b) => b.includes('Pricing sync'))!
result(
  'the wall clock still wins when it is the longer record',
  aLine.includes('30 min'),
  aLine.split('\n')[2]
)
result(
  'a note with neither a clock nor a transcript shows no duration at all',
  !/·\s*\d+\s*min/.test(
    listNotesTool(lib, { limit: 10, offset: 0 })
      .split('\n\n')
      .find((b) => b.includes('Dentist appointment'))!
  )
)

header('search_notes')
const s1 = searchNotesTool(lib, { query: 'renewal', limit: 5 })
result('finds a word from the notes body', s1.includes('Pricing sync'), s1.split('\n')[0])
result('search result carries the note id', s1.includes(`id: ${a}`))
const s2 = searchNotesTool(lib, { query: 'ninety seconds', limit: 5 })
result('finds words only ever spoken (transcript is indexed)', s2.includes('Infra review'))
const s3 = searchNotesTool(lib, { query: 'renewal failover', limit: 5 })
result(
  'falls back from all-terms to any-term',
  s3.includes('any term') && s3.includes('Pricing sync') && s3.includes('Infra review'),
  s3.split('\n')[0]
)
result(
  'stopwords do not drown the real terms',
  searchNotesTool(lib, { query: 'what did we say about the renewal', limit: 5 }).includes(
    'Pricing sync'
  )
)
const scopedMiss = searchNotesTool(lib, { query: 'renewal', limit: 5, folder: 'Personal' })
result('search honours folder scope', scopedMiss.includes('No notes'))
result(
  'a scoped miss says the scope excluded it, not that nothing matches',
  scopedMiss.includes('folder "Personal"') && scopedMiss.includes('were not searched'),
  scopedMiss.split('\n')[0].slice(0, 80)
)
result(
  'snippet strips the editor sentinels',
  !searchNotesTool(lib, { query: 'renewal terms', limit: 5 }).includes('⟦U⟧')
)
let injected = ''
try {
  injected = searchNotesTool(lib, { query: 'renewal" OR body:* AND "', limit: 5 })
} catch (err) {
  injected = `THREW: ${(err as Error).message}`
}
result('fts syntax in the query is quoted, not executed', injected.includes('Pricing sync'), 'no throw')
result(
  'a query of pure punctuation is handled',
  searchNotesTool(lib, { query: '!!! ???', limit: 5 }).includes('no searchable words')
)

header('get_note')
const noteA = getNoteTool(lib, {
  note_id: a,
  include: ['rough_notes', 'enhanced_notes'],
  max_chars: 40_000
})
result('returns the rough notes', noteA.includes('renewal terms'))
result('returns the enhanced notes', noteA.includes('Acme wants 18 months'))
result(
  'strips every sentinel bracket, including half-emitted ones',
  !noteA.includes('⟦') && !noteA.includes('⟧'),
  noteA.includes('stray closer') ? 'residue line present, brackets gone' : 'line missing'
)
result(
  'accepts an id prefix',
  getNoteTool(lib, { note_id: a.slice(0, 8), include: ['enhanced_notes'], max_chars: 1000 }).includes(
    'Acme'
  )
)
const clipped = getNoteTool(lib, { note_id: a, include: ['enhanced_notes'], max_chars: 500 })
result('reports truncation instead of silently cutting', clipped.includes('more characters'))
const withTranscript = getNoteTool(lib, {
  note_id: a,
  include: ['transcript'],
  max_chars: 40_000
})
result('inlines the transcript on request', withTranscript.includes('[0:05] [Speaker 1]'))
let badId = ''
try {
  getNoteTool(lib, { note_id: 'Pricing', include: ['enhanced_notes'], max_chars: 1000 })
} catch (err) {
  badId = (err as Error).message
}
result('unknown id suggests notes by title', badId.includes('Pricing sync'), badId.slice(0, 48))

header('get_transcript')
const t1 = getTranscriptTool(lib, { note_id: a, offset: 0, limit: 2 })
result('labels mic as Me and system speakers by index', t1.includes('[0:01] [Me]'))
result('paging tells the caller the next offset', t1.includes('call again with offset: 2'))
const t2 = getTranscriptTool(lib, { note_id: a, offset: 2, limit: 2 })
result('last page has no continuation marker', !t2.includes('call again with offset'))
result(
  'offset past the end explains itself',
  getTranscriptTool(lib, { note_id: a, offset: 99, limit: 2 }).includes('past the end')
)
result(
  'a note with no transcript says so',
  getTranscriptTool(lib, { note_id: c, offset: 0, limit: 10 }).includes('no transcript')
)

header('search_transcript')
const st = searchTranscriptTool(lib, { query: 'eighteen months', limit: 10, context_lines: 1 })
result('matches a multi-word spoken phrase', st.includes('Acme needs eighteen months'))
result('marks the matched line', st.includes('> [0:05]'))
result('includes surrounding context lines', st.includes('twelve percent'))
const stAll = searchTranscriptTool(lib, { query: 'percent', limit: 10, context_lines: 0 })
result('scopes to one note when asked', !stAll.includes('failover'))
const scoped = searchTranscriptTool(lib, {
  query: 'the',
  limit: 10,
  context_lines: 0,
  note_id: b
})
result('note_id scope excludes other notes', !scoped.includes('Pricing sync'))
result(
  'literal search is case-insensitive',
  searchTranscriptTool(lib, { query: 'ACME', limit: 5, context_lines: 0 }).includes('Acme needs')
)
result(
  'no spoken match is explained, not empty',
  searchTranscriptTool(lib, { query: 'zzzznotspoken', limit: 5, context_lines: 0 }).includes(
    'Nothing spoken matches'
  )
)
// "the" appears in two of A's three lines. (It used to be "e", which only
// matched anything back when a single letter could match mid-word.)
const grouped = searchTranscriptTool(lib, { query: 'the', limit: 4, context_lines: 0, note_id: a })
result(
  'repeated hits in one note print the header once',
  grouped.split(`id: ${a}`).length - 1 === 1,
  `${grouped.split(`id: ${a}`).length - 1} headers`
)

lib.db.close()
closeDb()

// ---------------------------------------------------------------------------
// The real spawn path: plain node, stdio JSON-RPC, no loader hooks
// ---------------------------------------------------------------------------

header('MCP protocol over stdio (plain node, as Claude Desktop spawns it)')

interface RpcMessage {
  id?: number
  result?: {
    serverInfo?: { name: string }
    tools?: { name: string }[]
    content?: { type: string; text: string }[]
    isError?: boolean
  }
  error?: { message: string }
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GRANOLA_DB_PATH: dbPath, NODE_NO_WARNINGS: '1' }
})

let stderr = ''
child.stderr.on('data', (d: Buffer) => {
  stderr += d.toString()
})

const pending = new Map<number, (m: RpcMessage) => void>()
const junk: string[] = []
let buf = ''
child.stdout.on('data', (d: Buffer) => {
  buf += d.toString()
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line) as RpcMessage
      if (msg.id !== undefined) pending.get(msg.id)?.(msg)
    } catch {
      // Anything non-JSON on stdout corrupts the transport — record it rather
      // than swallowing it, because the failure mode in the wild is a client
      // that silently drops the server.
      junk.push(line)
    }
  }
})

let nextId = 1
function rpc(method: string, params: unknown): Promise<RpcMessage> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000)
  })
}

async function callTool(name: string, args: Record<string, unknown>): Promise<RpcMessage> {
  return rpc('tools/call', { name, arguments: args })
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stress', version: '1.0.0' }
  })
  result('initialize handshake succeeds', init.result?.serverInfo?.name === 'notetaker')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const tools = (await rpc('tools/list', {})).result?.tools ?? []
  const names = tools.map((t) => t.name).sort()
  result(
    'advertises every tool',
    names.join(',') ===
      'create_folder,create_note,delete_folder,delete_note,export_library,export_note,export_to_notion,get_graph,get_note,get_notes,get_transcript,import_recording,library_overview,list_folders,list_notes,outline,recording_status,related_notes,rename_folder,search_notes,search_transcript,start_recording,stop_recording,topics,update_note',
    names.join(',')
  )

  const ovCall = await callTool('library_overview', {})
  result(
    'library_overview returns the seeded library',
    ovCall.result?.content?.[0]?.text?.includes(`${EXPECT_NOTES} notes`) === true
  )

  const searchCall = await callTool('search_notes', { query: 'renewal' })
  result(
    'search_notes works over the wire with schema defaults applied',
    searchCall.result?.content?.[0]?.text?.includes('Pricing sync') === true
  )

  const errCall = await callTool('get_note', { note_id: 'does-not-exist' })
  result(
    'a bad argument comes back as a tool error, not a crash',
    errCall.result?.isError === true && errCall.error === undefined
  )

  const stillAlive = await callTool('list_folders', {})
  result(
    'server survives an errored call',
    stillAlive.result?.content?.[0]?.text?.includes('Product') === true
  )

  result('stdout carries only JSON-RPC frames', junk.length === 0, junk.slice(0, 2).join(' | '))
} catch (err) {
  result('MCP protocol session', false, (err as Error).message)
  if (stderr) console.log(`  server stderr:\n${stderr.split('\n').map((l) => `    ${l}`).join('\n')}`)
}

child.kill()
