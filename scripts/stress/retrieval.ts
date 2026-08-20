// Retrieval stress: the RAG pipeline end to end — structural chunking, hybrid
// BM25 + vector fusion, the cosine floor, and embedding-model healing.
//
// No network and no Voyage key: vectors are synthetic topic axes written
// straight into chunks.embedding via saveChunkEmbeddings, so every function the
// real searchChunks calls (listEmbeddedChunks → blobToF32 → cosineTopK) runs
// unmodified and only embedTexts is replaced. That makes the retrieval half of
// chat testable in CI while the embedding half stays a network concern.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/retrieval.ts
import { getDb, closeDb } from '../../src/main/db/database.ts'
import { MIGRATIONS } from '../../src/main/db/schema.ts'
import { createMeeting, updateTitle, saveNotes, saveEnhanced } from '../../src/main/db/meetings.ts'
import { createFolder, setMeetingFolder } from '../../src/main/db/folders.ts'
import { insertSegment } from '../../src/main/db/transcripts.ts'
import { reindexMeeting, searchMeetingIdsForChat } from '../../src/main/db/search.ts'
import {
  clearStaleEmbeddings,
  embeddingCoverage,
  listEmbeddedChunks,
  listUnchunkedMeetingIds,
  listUnembeddedChunks,
  saveChunkEmbeddings
} from '../../src/main/db/chunks.ts'
import {
  blobToF32,
  carryEmbeddings,
  chunkNote,
  cosineTopK,
  EMBED_MODEL,
  f32ToBlob,
  MIN_COSINE_SCORE,
  rrfMerge
} from '../../src/main/embeddings/lib.ts'
import { buildFolderContext, buildGlobalContext } from '../../src/main/chat/prompt.ts'
import type { TranscriptLine } from '../../src/main/enhance/prompt.ts'
import { header, result } from './_util.ts'

/** Mirrors CHUNK_TARGET_CHARS in embeddings/lib.ts (deliberately not exported —
 *  if it changes, this constant is the one place this suite needs updating). */
const CHUNK_TARGET = 1_600

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ───────────────────────────── structural chunking ─────────────────────────────

header('Chunking: section boundaries')

const noteLines = Array.from({ length: 30 }, (_, i) => `note line ${i} ${'w'.repeat(180)}`)
const sectionChunks = chunkNote([noteLines.join('\n')], [])
result('a long section splits into several chunks', sectionChunks.length > 1, `${sectionChunks.length}`)
result(
  'no chunk exceeds the ~1.6K target',
  sectionChunks.every((c) => c.length <= CHUNK_TARGET),
  `max ${Math.max(...sectionChunks.map((c) => c.length))}`
)
result(
  'cuts land on line boundaries (never mid-line)',
  sectionChunks.flatMap((c) => c.split('\n')).every((l) => noteLines.includes(l))
)
result(
  'every source line appears exactly once — no loss, and no overlap window',
  eq(
    sectionChunks.flatMap((c) => c.split('\n')),
    noteLines
  )
)

const longLine = 'x'.repeat(5_000)
const hardSplit = chunkNote([longLine], [])
result('a single overlong line is hard-split, not dropped', hardSplit.join('') === longLine)
result(
  'hard-split pieces respect the target',
  hardSplit.every((c) => c.length <= CHUNK_TARGET),
  `${hardSplit.length} pieces`
)

result('blank sections are skipped', chunkNote(['', '   ', '\n'], []).length === 0)

header('Chunking: sections and transcript are independent')

const secA = ['alpha one', 'alpha two'].join('\n')
const secB = ['beta one', 'beta two'].join('\n')
const convo: TranscriptLine[] = [
  { channel: 'mic', text: 'gamma one', startMs: 0, speaker: null },
  { channel: 'system', text: 'gamma two', startMs: 1_000, speaker: 0 }
]
const tail = [...chunkNote([secB], []), ...chunkNote([], convo)]
const baseNote = chunkNote([secA, secB], convo)
const editedNote = chunkNote([`${secA}\nalpha three`, secB], convo)
const tailOf = (chunks: string[]): string[] => chunks.slice(chunks.length - tail.length)
result(
  'editing one section leaves the other section and the transcript byte-identical',
  eq(tailOf(baseNote), tail) && eq(tailOf(editedNote), tail)
)
result('the edit does change its own section', !eq(baseNote, editedNote))

header('Chunking: transcript attribution and stability')

const labelled: TranscriptLine[] = [
  { channel: 'mic', text: 'one', startMs: 0, speaker: null },
  { channel: 'mic', text: 'two', startMs: 1_000, speaker: null },
  { channel: 'system', text: 'three', startMs: 2_000, speaker: 0 },
  { channel: 'system', text: 'four', startMs: 3_000, speaker: 0 },
  { channel: 'system', text: 'five', startMs: 4_000, speaker: 1 }
]
const EXPECTED_CHUNK = '[0:00-0:04]\n[Me] one\ntwo\n[Speaker 1] three\nfour\n[Speaker 2] five'
const labelledChunks = chunkNote([], labelled)
result(
  'transcript chunk carries one time-range header and a speaker label only on change',
  labelledChunks.length === 1 && labelledChunks[0] === EXPECTED_CHUNK,
  JSON.stringify(labelledChunks[0])
)

result(
  'blank transcript lines are skipped',
  eq(
    chunkNote([], [
      { channel: 'mic', text: '   ', startMs: 0, speaker: null },
      { channel: 'mic', text: 'real', startMs: 1_000, speaker: null }
    ]),
    ['[0:01-0:01]\n[Me] real']
  )
)

const manyTurns: TranscriptLine[] = Array.from(
  { length: 40 },
  (_, i): TranscriptLine => ({
    channel: i % 2 === 0 ? 'system' : 'mic',
    text: `turn ${i} ${'s'.repeat(150)}`,
    startMs: i * 2_000,
    speaker: i % 2 === 0 ? 0 : null
  })
)
const shortRun = chunkNote([], manyTurns.slice(0, 24))
const grownRun = chunkNote([], manyTurns)
result(
  'appending speech leaves earlier chunks byte-identical (carried embeddings survive)',
  shortRun.length >= 2 && eq(shortRun.slice(0, -1), grownRun.slice(0, shortRun.length - 1)),
  `${shortRun.length} → ${grownRun.length} chunks`
)
result(
  'every segment appears in exactly one chunk (no overlap window)',
  eq(
    grownRun.flatMap((c) => c.split('\n').slice(1)).map((l) => l.replace(/^\[[^\]]+\] /, '')),
    manyTurns.map((t) => t.text)
  )
)
// The packing budget counts rendered lines only, so a chunk may exceed the
// target by its "[m:ss-m:ss]\n" header — a fixed ~13 chars, not unbounded.
result(
  'transcript chunks respect the target (plus the time-range header)',
  grownRun.every((c) => c.length <= CHUNK_TARGET + 32),
  `max ${Math.max(...grownRun.map((c) => c.length))}`
)

const hugeSegment = chunkNote([], [
  { channel: 'mic', text: 'z'.repeat(4_000), startMs: 65_000, speaker: null }
])
result(
  'a pathological single segment is hard-split, each piece stamped with its time',
  hugeSegment.length === 3 &&
    hugeSegment.every((c) => c.startsWith('[1:05] ')) &&
    hugeSegment.map((c) => c.slice('[1:05] '.length)).join('') === `[Me] ${'z'.repeat(4_000)}`,
  `${hugeSegment.length} pieces`
)

// ───────────────────────────── db: chunk rows and healing ─────────────────────

const db = getDb()

const doc = (lines: string[]): string =>
  JSON.stringify({
    type: 'doc',
    content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }))
  })

interface ChunkProbe {
  id: number
  seq: number
  text: string
  embedding: Uint8Array | null
  model: string | null
  dim: number | null
}
const chunksOf = (meetingId: string): ChunkProbe[] =>
  db
    .prepare('SELECT id, seq, text, embedding, model, dim FROM chunks WHERE meeting_id = ? ORDER BY seq')
    .all(meetingId) as unknown as ChunkProbe[]

function makeNote(
  title: string,
  lines: string[],
  segments: string[] = [],
  folderId: string | null = null
): string {
  const m = createMeeting()
  updateTitle(m.id, title)
  saveNotes(m.id, doc(lines))
  segments.forEach((text, i) =>
    insertSegment(m.id, i % 2 === 0 ? 'system' : 'mic', text, i * 2_000, i * 2_000 + 1_900, i % 2 === 0 ? 0 : null)
  )
  if (folderId) setMeetingFolder(m.id, folderId)
  reindexMeeting(m.id)
  return m.id
}

// Four topic axes so a query can be orthogonal to everything in the library.
const TOPIC = {
  infra: [1, 0, 0, 0],
  hiring: [0, 1, 0, 0],
  budget: [0, 0, 1, 0]
}
const HIRING_QUERY = [0.15, 0.98, 0.1, 0]
const OFF_TOPIC_QUERY = [0, 0, 0, 1]

function embedMeeting(meetingId: string, vectorFor: (seq: number) => number[] | null, model = EMBED_MODEL): void {
  const rows = chunksOf(meetingId).flatMap((r) => {
    const v = vectorFor(r.seq)
    return v ? [{ id: r.id, embedding: f32ToBlob(v) }] : []
  })
  saveChunkEmbeddings(rows, model)
}

header('Chunk rows: model/dim stamping')

const carryId = makeNote(
  'Carry note',
  ['carry note alpha', 'carry note beta'],
  Array.from({ length: 24 }, (_, i) => `segment ${i} ${'q'.repeat(150)}`)
)
const fresh = chunksOf(carryId)
result('reindex produces chunks', fresh.length >= 3, `${fresh.length} chunks`)
result(
  'an unembedded chunk carries no model or dim',
  fresh.every((c) => c.embedding === null && c.model === null && c.dim === null)
)
result(
  'chunked_at is stamped so the backfill converges',
  (db.prepare('SELECT chunked_at FROM meetings WHERE id = ?').get(carryId) as { chunked_at: number | null })
    .chunked_at !== null
)

embedMeeting(carryId, () => TOPIC.budget)
const embedded = chunksOf(carryId)
result(
  'saveChunkEmbeddings stamps model and dim on every row it writes',
  embedded.every((c) => c.embedding !== null && c.model === EMBED_MODEL && c.dim === 4)
)

const invariant = (): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE (embedding IS NULL) <> (model IS NULL)').get() as {
    c: number
  }).c
result('invariant: model is set iff embedding is set', invariant() === 0, `${invariant()} violations`)

header('Chunk rows: only what changed loses its vector')

saveNotes(carryId, doc(['carry note alpha edited', 'carry note beta']))
reindexMeeting(carryId)
const afterEdit = chunksOf(carryId)
result('the edited note section is re-queued for embedding', afterEdit[0].embedding === null)
result(
  'untouched transcript chunks keep their vectors',
  afterEdit.slice(1).every((c) => c.embedding !== null && c.model === EMBED_MODEL),
  `${afterEdit.slice(1).filter((c) => c.embedding !== null).length}/${afterEdit.length - 1} kept`
)
result('invariant holds after a partial rebuild', invariant() === 0)
result(
  'the re-queued chunk is what the embedder picks up next',
  listUnembeddedChunks(50).some((c) => c.id === afterEdit[0].id)
)

header('Chunk rows: enhanced notes are their own section')

// enhanced_md is stored line-structured (ipc.ts writes pmToPlainText of the
// edited doc), which is what lets the section chunker cut on real markdown
// lines — and it must stay a separate section from the rough notes.
const enhId = makeNote('Enhanced note', ['rough line one'], ['spoken line one'])
saveEnhanced(enhId, '{}', '# Heading\n- bullet one\n- bullet two')
reindexMeeting(enhId)
const enhChunks = chunksOf(enhId)
result('rough notes stay their own chunk', enhChunks[0]?.text === 'rough line one', enhChunks[0]?.text)
result(
  'the enhanced doc is chunked separately and keeps its line structure',
  enhChunks[1]?.text === '# Heading\n- bullet one\n- bullet two',
  JSON.stringify(enhChunks[1]?.text)
)
saveNotes(enhId, doc(['rough line one edited']))
reindexMeeting(enhId)
result(
  'editing the rough notes leaves the enhanced chunk byte-identical',
  chunksOf(enhId)[1]?.text === enhChunks[1]?.text
)

header('Embedding-model change heals')

embedMeeting(carryId, (seq) => (seq === 0 ? TOPIC.budget : null))
const staleTarget = chunksOf(carryId)[1]
saveChunkEmbeddings([{ id: staleTarget.id, embedding: f32ToBlob(TOPIC.budget) }], 'voyage-2-legacy')
result(
  'a stale-model row is still a normal embedded row (cosineTopK cannot tell)',
  listEmbeddedChunks(null).some((c) => c.meeting_id === carryId && c.seq === staleTarget.seq)
)

const cleared = clearStaleEmbeddings(EMBED_MODEL)
const healed = chunksOf(carryId)
result('clearStaleEmbeddings NULLs exactly the other-model rows', cleared === 1, `${cleared} cleared`)
result(
  'the stale row is now unembedded and un-retrievable',
  healed[1].embedding === null && healed[1].model === null && healed[1].dim === null
)
result(
  'current-model rows are untouched by the heal',
  healed.filter((c) => c.model === EMBED_MODEL).length === healed.length - 1
)
result('the cleared row is queued for re-embedding', listUnembeddedChunks(50).some((c) => c.id === healed[1].id))
result('invariant holds after healing', invariant() === 0)

reindexMeeting(carryId)
result(
  'a rebuild does not resurrect a cleared vector',
  chunksOf(carryId)[1].embedding === null
)

// Second healing path: a rebuild also drops a stale-model vector, because
// carryEmbeddings refuses to carry one.
saveChunkEmbeddings([{ id: healed[2].id, embedding: f32ToBlob(TOPIC.budget) }], 'voyage-2-legacy')
reindexMeeting(carryId)
result(
  'a rebuild drops a stale-model vector even without clearStaleEmbeddings',
  chunksOf(carryId)[2].embedding === null && chunksOf(carryId)[2].model === null
)

// The v8 upgrade path: rows embedded before the model column existed have
// embedding set and model NULL. Their provenance is unknown, so they must be
// cleared too — `model IS NOT ?` (not `!=`) is what makes that true of NULLs.
const preV8Id = makeNote('Pre-v8 note', ['legacy embedded chunk'])
embedMeeting(preV8Id, () => TOPIC.infra)
db.prepare('UPDATE chunks SET model = NULL WHERE meeting_id = ?').run(preV8Id)
const preV8Cleared = clearStaleEmbeddings(EMBED_MODEL)
result(
  'a vector predating the model column is cleared too (unknown provenance)',
  preV8Cleared === 1 && chunksOf(preV8Id).every((c) => c.embedding === null),
  `${preV8Cleared} cleared`
)

const coverage = embeddingCoverage()
const counted = db.prepare('SELECT COUNT(*) AS t, COUNT(embedding) AS e FROM chunks').get() as {
  t: number
  e: number
}
result(
  'embeddingCoverage reports the real total/embedded split',
  coverage.total === counted.t && coverage.embedded === counted.e,
  `${coverage.embedded}/${coverage.total}`
)

header('carryEmbeddings')

const oneVec = f32ToBlob(TOPIC.infra)
const carried = carryEmbeddings(
  [
    { text: 'kept', embedding: oneVec, model: EMBED_MODEL },
    { text: 'stale', embedding: oneVec, model: 'voyage-2-legacy' },
    { text: 'dropped', embedding: oneVec, model: EMBED_MODEL }
  ],
  ['brand new', 'kept', 'stale'],
  EMBED_MODEL
)
result('a new chunk starts with no vector', carried[0].embedding === null)
result('an unchanged chunk keeps its vector even after moving position', carried[1].embedding !== null)
result('a vector from another embedding model is never carried', carried[2].embedding === null)

header('Schema invariants the retrieval path depends on')

const { user_version: userVersion } = db.prepare('PRAGMA user_version').get() as {
  user_version: number
}
result('schema is at the latest migration', userVersion === MIGRATIONS.length, `v${userVersion}`)
result(
  'partial index for the unembedded probe exists',
  (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chunks_unembedded'")
    .all() as unknown as { name: string }[]).length === 1
)
const plan = db
  .prepare('EXPLAIN QUERY PLAN SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT 8')
  .all() as unknown as { detail: string }[]
result(
  'the unembedded probe actually uses the partial index',
  plan.some((p) => p.detail.includes('idx_chunks_unembedded')),
  plan.map((p) => p.detail).join(' | ')
)

const emptyNote = createMeeting()
reindexMeeting(emptyNote.id)
result(
  'a note with no text still converges (chunked_at stamped, zero chunks)',
  chunksOf(emptyNote.id).length === 0 && !listUnchunkedMeetingIds().includes(emptyNote.id)
)

reindexMeeting(carryId)
reindexMeeting(carryId)
const ftsRows = db.prepare('SELECT rowid AS rid FROM search_fts WHERE meeting_id = ?').all(carryId) as unknown as {
  rid: number
}[]
const { fts_rowid: ftsRowid } = db.prepare('SELECT fts_rowid FROM meetings WHERE id = ?').get(carryId) as {
  fts_rowid: number | null
}
result('exactly one FTS row per meeting after repeated reindexes', ftsRows.length === 1, `${ftsRows.length} rows`)
result('meetings.fts_rowid addresses that row', ftsRows.length === 1 && ftsRows[0].rid === ftsRowid)

// ───────────────────────────── cosine floor ───────────────────────────────────

header('Cosine floor')

const unit = (c: number): Float32Array => new Float32Array([c, Math.sqrt(1 - c * c)])
const axis = new Float32Array([1, 0])
const floorCandidates = [
  { item: 'strong', vector: unit(0.9) },
  { item: 'just above', vector: unit(0.31) },
  { item: 'just below', vector: unit(0.29) },
  { item: 'orthogonal', vector: new Float32Array([0, 1]) },
  { item: 'wrong dim', vector: new Float32Array([1, 0, 0]) }
]
const floored = cosineTopK(axis, floorCandidates, 10)
const kept = floored.map((f) => f.item)
result('MIN_COSINE_SCORE is the documented 0.3', MIN_COSINE_SCORE === 0.3, `${MIN_COSINE_SCORE}`)
result('a hit just above the floor is kept', kept.includes('just above'))
result('a hit just below the floor is dropped', !kept.includes('just below'))
result('an orthogonal hit is dropped', !kept.includes('orthogonal'))
result('a mismatched-dimension vector is skipped, not scored', !kept.includes('wrong dim'))
result('fewer than k hits come back rather than a padded top-k', floored.length === 2, `${floored.length} of k=10`)
result('hits are ordered by descending score', kept[0] === 'strong')
result('k still caps the result', cosineTopK(axis, floorCandidates, 1).length === 1)
result(
  'a fully off-topic query returns nothing at all',
  cosineTopK(new Float32Array([0, 1]), [{ item: 'x', vector: new Float32Array([1, 0]) }], 5).length === 0
)

// ───────────────────────────── RRF fusion ─────────────────────────────────────

header('RRF fusion')

const fusedSynthetic = rrfMerge([
  ['keyword-only', 'consensus', 'kw-tail'],
  ['vector-only', 'consensus', 'vec-tail']
])
result(
  'a note ranked second by both beats a note ranked first by one',
  fusedSynthetic[0] === 'consensus',
  fusedSynthetic.join(', ')
)
result(
  'hits unique to one ranking survive fusion',
  fusedSynthetic.includes('keyword-only') && fusedSynthetic.includes('vector-only')
)
result('fusion never duplicates an id', new Set(fusedSynthetic).size === fusedSynthetic.length)
result('empty rankings are tolerated', rrfMerge([[], []]).length === 0 && eq(rrfMerge([[], ['x']]), ['x']))

// ───────────────────────────── hybrid end-to-end ──────────────────────────────

header('Hybrid retrieval over a real index')

interface Hit {
  meetingId: string
  seq: number
  text: string
  score: number
}
/** searchChunks' body with the Voyage call replaced by a caller-supplied vector. */
function vectorSearch(queryVec: number[], folderId: string | null, k: number): Hit[] {
  const query = new Float32Array(queryVec)
  const candidates = listEmbeddedChunks(folderId).map((c) => ({
    item: c,
    vector: blobToF32(c.embedding!)
  }))
  return cosineTopK(query, candidates, k).map(({ item, score }) => ({
    meetingId: item.meeting_id,
    seq: item.seq,
    text: item.text,
    score
  }))
}

const kwId = makeNote('Q3 status', ['hiring for the platform team is unblocked'])
const BURIED = 'onboarding buddy rotation starts in august'
const vecLines = [
  ...Array.from({ length: 24 }, (_, i) => `we should bring on two more engineers for checkout ${i} ${'f'.repeat(120)}`),
  BURIED,
  ...Array.from({ length: 12 }, (_, i) => `summer rush capacity review ${i} ${'g'.repeat(120)}`)
]
const vecId = makeNote('Weekly sync', vecLines)
const buriedSeq = chunksOf(vecId).findIndex((c) => c.text.includes(BURIED))

embedMeeting(kwId, () => TOPIC.infra)
embedMeeting(vecId, (seq) => (seq === buriedSeq ? TOPIC.hiring : TOPIC.budget))

const QUESTION = 'what did we decide about hiring the platform team'
const bm25Ids = searchMeetingIdsForChat(QUESTION)
const vectorHits = vectorSearch(HIRING_QUERY, null, 24)
const vectorIds = [...new Set(vectorHits.map((h) => h.meetingId))]
const fused = rrfMerge([bm25Ids, vectorIds])

result('the note is chunked into enough pieces to bury a passage', buriedSeq >= 2, `buried at seq ${buriedSeq}`)
result('BM25 finds the literal-keyword note', bm25Ids.includes(kwId), bm25Ids.join(', '))
result('BM25 alone misses the paraphrased note', !bm25Ids.includes(vecId))
result('vector search finds the paraphrased note', vectorIds.includes(vecId))
result('vector search leaves the off-axis note below the floor', !vectorIds.includes(kwId))
result('the vector hit is the buried chunk, not the head of the note', vectorHits[0]?.seq === buriedSeq, `seq ${vectorHits[0]?.seq}`)
result('fusion keeps both retrieval modes hits', fused.includes(kwId) && fused.includes(vecId))
result('fusion never duplicates a meeting', new Set(fused).size === fused.length)

const offTopic = vectorSearch(OFF_TOPIC_QUERY, null, 24)
result('an off-topic question yields zero vector hits', offTopic.length === 0, `${offTopic.length} hits`)
result('with no vector hits, fusion degrades to the keyword ranking', eq(rrfMerge([bm25Ids, []]), bm25Ids))

result('an all-stopword question does not query FTS at all', eq(searchMeetingIdsForChat('what did they say about it'), []))
result('the FTS limit is honoured', searchMeetingIdsForChat(QUESTION, 1).length <= 1)
let chatFtsThrew = false
try {
  searchMeetingIdsForChat('"hiring" AND (platform NEAR team')
} catch {
  chatFtsThrew = true
}
result('a question full of FTS syntax never throws', !chatFtsThrew)

// ───────────────────────────── folder scoping ─────────────────────────────────

header('Folder scoping (retrieval must not cross folders)')

const infraFolder = createFolder('Infra')
const peopleFolder = createFolder('People')
const infraId = makeNote(
  'Migration plan',
  ['kubelet drain runbook needs a rewrite', 'cutover window is the last weekend of the month'],
  [],
  infraFolder.id
)
const peopleId = makeNote('Comp review', ['compensation bands refresh in september'], [], peopleFolder.id)
embedMeeting(infraId, () => TOPIC.infra)
embedMeeting(peopleId, () => TOPIC.hiring)

const infraCandidates = listEmbeddedChunks(infraFolder.id)
result(
  'vector candidates are folder-scoped',
  infraCandidates.length > 0 && infraCandidates.every((c) => c.meeting_id === infraId),
  `${infraCandidates.length} chunks`
)
// The People note is an on-axis match for HIRING_QUERY, so the only thing that
// can keep it out of an Infra-scoped search is the folder scope itself.
result(
  'the same query does match, unscoped',
  vectorSearch(HIRING_QUERY, null, 24).some((h) => h.meetingId === peopleId)
)
result(
  'scoped to its own folder it is still found',
  vectorSearch(HIRING_QUERY, peopleFolder.id, 24).every((h) => h.meetingId === peopleId) &&
    vectorSearch(HIRING_QUERY, peopleFolder.id, 24).length > 0
)
result(
  'scoped to another folder it is unreachable (scope, not score)',
  vectorSearch(HIRING_QUERY, infraFolder.id, 24).length === 0
)

const folderCtx = await buildFolderContext('what is the kubelet drain runbook', peopleFolder.id, 'People', 200_000)
const folderExcerpts = folderCtx.userTurn.split('</meetings>')[0]
result(
  'folder context names its folder',
  folderCtx.system.startsWith('Folder: People'),
  folderCtx.system.split('\n')[0]
)
result('folder context excludes another folder content', !folderExcerpts.includes('kubelet'))
result('folder context includes its own note', folderExcerpts.includes('compensation bands'))
result(
  'folder index lists only the folder notes',
  folderCtx.system.includes('Comp review') && !folderCtx.system.includes('Migration plan')
)

const globalCtx = await buildGlobalContext('what is the kubelet drain runbook', 200_000)
result(
  'global context retrieves the same note the folder thread refused',
  globalCtx.userTurn.split('</meetings>')[0].includes('kubelet')
)
result('global index lists the library', globalCtx.system.includes('<meeting_index>') && globalCtx.system.includes('Migration plan'))
result('the question is carried into the user turn', globalCtx.userTurn.includes('Question: what is the kubelet drain runbook'))

closeDb()
console.log('\nretrieval complete')
