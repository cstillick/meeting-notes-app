// Read-only SQLite access for the MCP server.
//
// Deliberately standalone: nothing in src/mcp imports from src/main/db (which
// reaches for `electron`), so this runs under plain Node with no loader hooks —
// which is exactly how Claude Desktop spawns it. Every statement here is a
// SELECT and the handle is opened read-only, so a model driving these tools can
// never alter the user's library.
//
// Freshness comes for free: each statement runs in its own implicit read
// transaction, so a query issued while the app is recording sees every final
// committed so far. No cache to invalidate.
import { DatabaseSync } from 'node:sqlite'
import { speakerKey } from '../main/enhance/prompt.ts'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB_FILE = 'granola-clone.db'

/** userData directory names Electron may have used: `name` from package.json
 *  while running `npm run dev`, `productName` once electron-builder packages
 *  the app. Both are real states, and they are different databases. */
const USERDATA_DIRS = ['granola-clone', 'Granola Clone']

export function candidateDbPaths(): string[] {
  const override = process.env.GRANOLA_DB_PATH
  if (override) return [override]
  const base = join(homedir(), 'Library', 'Application Support')
  return USERDATA_DIRS.map((d) => join(base, d, DB_FILE))
}

/** Newest activity on a database, WAL-aware: under WAL the main file's mtime
 *  moves only on checkpoint, so a library with an hour of recent writes can
 *  look older than one that checkpointed at close. The -wal/-shm mtimes carry
 *  the real recency. */
function latestActivityMs(dbPath: string): number {
  let latest = 0
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      latest = Math.max(latest, statSync(p).mtimeMs)
    } catch {
      // companion file absent — fine
    }
  }
  return latest
}

/** The library to serve, or null when no candidate exists. Newest activity wins
 *  so a dev database and a packaged one can coexist without silently serving
 *  the stale one. */
export function resolveDbPath(): string | null {
  const found = candidateDbPaths().filter((p) => existsSync(p))
  if (found.length === 0) return null
  return found.sort((a, b) => latestActivityMs(b) - latestActivityMs(a))[0]
}

export interface Library {
  db: DatabaseSync
  path: string
  /** 'readonly' = the handle itself cannot write. 'query_only' = a writable
   *  handle pinned by PRAGMA, used only when a hot WAL (left by a crash or a
   *  running app) needs recovery, which SQLite cannot do read-only. */
  mode: 'readonly' | 'query_only'
  /** False on a pre-v4 database — folder columns are absent, so folder
   *  filtering and folder names degrade instead of throwing. */
  hasFolders: boolean
  /** The v11 speaker-roster tables. A newer MCP build must degrade to generated
   *  labels against an older library rather than throwing, exactly as
   *  hasFolders does for a pre-v4 one. */
  hasSpeakerRoster: boolean
}

function openHandle(path: string, readOnly: boolean): DatabaseSync {
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000')
  // Force WAL recovery here rather than on the first tool call: a read-only
  // handle fails at that moment, and the point of this probe is to fall back
  // before any tool has a chance to see the failure. For the writable
  // fallback, the probe runs BEFORE query_only is pinned — WAL recovery is a
  // write, and the whole reason this branch holds a writable handle is to let
  // that recovery happen; pinning first would defeat it.
  db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get()
  if (!readOnly) db.exec('PRAGMA query_only = ON')
  return db
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return cols.some((c) => c.name === column)
}

export function openLibrary(path: string): Library {
  let db: DatabaseSync
  let mode: Library['mode']
  try {
    db = openHandle(path, true)
    mode = 'readonly'
  } catch (err) {
    // A writable open on a missing path would CREATE an empty database and
    // serve it as the library. resolveDbPath checked existsSync, but the file
    // can vanish between that check and this open — re-check at the boundary.
    if (!existsSync(path)) throw err
    db = openHandle(path, false)
    mode = 'query_only'
  }

  for (const t of ['meetings', 'transcript_segments', 'search_fts']) {
    if (!tableExists(db, t)) {
      db.close()
      throw new Error(
        `${path} is missing the "${t}" table — this does not look like a Notetaker library.`
      )
    }
  }
  const hasFolders = tableExists(db, 'folders') && columnExists(db, 'meetings', 'folder_id')
  const hasSpeakerRoster =
    tableExists(db, 'speaker_identities') && tableExists(db, 'speaker_keys')
  return { db, path, mode, hasFolders, hasSpeakerRoster }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface NoteMeta {
  id: string
  title: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  status: string
  folderId: string | null
  folderName: string | null
  hasEnhanced: boolean
  segmentCount: number
  /** Furthest point reached by the transcript, in ms from the recording start.
   *  A second, independent measure of how long the meeting ran — see the note
   *  on duration() in tools.ts for why the clock alone is not trustworthy. */
  transcriptMs: number
}

export interface NoteContent extends NoteMeta {
  notesJson: string
  enhancedMd: string | null
  enhancedAt: number | null
}

export interface SegmentRow {
  /** Row identity. Carried because start_ms is not unique — the mic and system
   *  channels routinely produce segments that begin in the same millisecond,
   *  and locating a hit by timestamp alone silently resolves both to the first
   *  of the pair (one line lost, the other shown twice). */
  id: number
  channel: 'mic' | 'system'
  text: string
  startMs: number
  speaker: number | null
}

export interface SearchHit extends NoteMeta {
  snippet: string
}

interface RawMeta {
  id: string
  title: string
  created_at: number
  started_at: number | null
  ended_at: number | null
  status: string
  folder_id: string | null
  folder_name: string | null
  has_enhanced: number
  segment_count: number
  transcript_ms: number
}

function toMeta(r: RawMeta): NoteMeta {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    folderId: r.folder_id,
    folderName: r.folder_name,
    hasEnhanced: r.has_enhanced === 1,
    segmentCount: r.segment_count,
    transcriptMs: r.transcript_ms
  }
}

/** The metadata every listing shares. Split out because search joins it onto an
 *  FTS match while list/get select it straight from meetings. */
function metaColumns(lib: Library): string {
  return `m.id, m.title, m.created_at, m.started_at, m.ended_at, m.status,
          ${lib.hasFolders ? 'm.folder_id' : 'NULL'} AS folder_id,
          ${lib.hasFolders ? 'f.name' : 'NULL'} AS folder_name,
          (m.enhanced_md IS NOT NULL AND m.enhanced_md != '') AS has_enhanced,
          (SELECT COUNT(*) FROM transcript_segments s WHERE s.meeting_id = m.id) AS segment_count,
          (SELECT COALESCE(MAX(s.end_ms), 0) FROM transcript_segments s WHERE s.meeting_id = m.id) AS transcript_ms`
}

function folderJoin(lib: Library): string {
  return lib.hasFolders ? 'LEFT JOIN folders f ON f.id = m.folder_id' : ''
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Everything this module binds into a statement. Narrower than node:sqlite's
 *  SQLInputValue (no BLOBs, no bigints) — every filter here is text or a
 *  timestamp, and nothing is ever interpolated into SQL. */
type BindValue = string | number | null

export interface ListFilters {
  /** Folder id, folder name, or the literal 'unfiled'. */
  folder?: string
  /** Substring the title must contain. The load-bearing case is structured
   *  titles: a course library numbers its notes "2.1.4 …", so "2." selects a
   *  whole topic in a way no full-text query can — FTS tokenizes "2.1.4" into
   *  the separate tokens 2, 1 and 4 and loses the ordering entirely. */
  titleContains?: string
  /** Prefix the title must start with. Distinct from titleContains because a
   *  numbered syllabus needs anchoring: "2." appears inside "1.2.10" too, so a
   *  substring filter for topic 2 quietly drags in a third of topic 1. */
  titleStartsWith?: string
  status?: string
  /** Inclusive lower bound on created_at, as ms. */
  afterMs?: number
  /** Exclusive upper bound on created_at, as ms. */
  beforeMs?: number
}

export interface ResolvedFolder {
  kind: 'folder' | 'unfiled'
  id: string | null
  name: string
}

/** Map a user-supplied folder reference onto a real folder. Models pass names
 *  far more often than ids, so name matching (exact, then case-insensitive,
 *  then prefix) is the common path. Returns null when nothing matches, which
 *  callers surface as an error rather than silently listing everything. */
export function resolveFolder(lib: Library, ref: string): ResolvedFolder | null {
  const wanted = ref.trim()
  if (!wanted) return null
  if (/^(unfiled|none|no folder)$/i.test(wanted)) {
    return { kind: 'unfiled', id: null, name: 'unfiled' }
  }
  if (!lib.hasFolders) return null
  const row = lib.db
    .prepare(
      `SELECT id, name FROM folders
        WHERE id = ?1 OR name = ?1 COLLATE NOCASE OR name LIKE ?2 ESCAPE '\\'
        ORDER BY (id = ?1) DESC, (name = ?1 COLLATE NOCASE) DESC, LENGTH(name)
        LIMIT 1`
    )
    .get(wanted, `${escapeLike(wanted)}%`) as { id: string; name: string } | undefined
  return row ? { kind: 'folder', id: row.id, name: row.name } : null
}

export function listFolderNames(lib: Library): string[] {
  if (!lib.hasFolders) return []
  return (
    lib.db.prepare('SELECT name FROM folders ORDER BY name COLLATE NOCASE').all() as unknown as {
      name: string
    }[]
  ).map((r) => r.name)
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** SQL fragment + bound values for the shared list/search filters. */
function buildFilters(
  lib: Library,
  f: ListFilters,
  folder: ResolvedFolder | null
): { sql: string; params: BindValue[] } {
  const clauses: string[] = []
  const params: BindValue[] = []
  if (folder) {
    if (folder.kind === 'unfiled') clauses.push('m.folder_id IS NULL')
    else {
      clauses.push('m.folder_id = ?')
      params.push(folder.id)
    }
  }
  if (f.titleContains) {
    clauses.push("m.title LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(f.titleContains)}%`)
  }
  if (f.titleStartsWith) {
    clauses.push("m.title LIKE ? ESCAPE '\\'")
    params.push(`${escapeLike(f.titleStartsWith)}%`)
  }
  if (f.status) {
    clauses.push('m.status = ?')
    params.push(f.status)
  }
  if (f.afterMs !== undefined) {
    clauses.push('m.created_at >= ?')
    params.push(f.afterMs)
  }
  if (f.beforeMs !== undefined) {
    clauses.push('m.created_at < ?')
    params.push(f.beforeMs)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params }
}

// ---------------------------------------------------------------------------
// Listing and fetching
// ---------------------------------------------------------------------------

export function listNotes(
  lib: Library,
  opts: ListFilters & { limit: number; offset: number; folderRef?: ResolvedFolder | null }
): { notes: NoteMeta[]; total: number } {
  const folder = opts.folderRef ?? null
  const { sql, params } = buildFilters(lib, opts, folder)
  const total = (
    lib.db.prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE 1=1${sql}`).get(...params) as {
      n: number
    }
  ).n
  const rows = lib.db
    .prepare(
      `SELECT ${metaColumns(lib)}
         FROM meetings m ${folderJoin(lib)}
        WHERE 1=1${sql}
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as unknown as RawMeta[]
  return { notes: rows.map(toMeta), total }
}

export interface OutlineRow {
  id: string
  title: string
  createdAt: number
  folderName: string | null
  status: string
  hasEnhanced: boolean
}

/** A whole folder's titles in one call, cheaply. list_notes is the wrong shape
 *  for this: it spends two correlated subqueries and three lines of prose per
 *  note, which over a 91-note course folder is ~20KB to answer "what is in
 *  here". This drops the per-note subqueries entirely and returns one row each,
 *  so a model can see the shape of a library — and, when titles are numbered,
 *  infer its structure — before deciding what to actually read. */
export function outlineNotes(
  lib: Library,
  opts: ListFilters & { limit: number; byTitle: boolean; folderRef?: ResolvedFolder | null }
): { rows: OutlineRow[]; total: number } {
  const { sql, params } = buildFilters(lib, opts, opts.folderRef ?? null)
  const total = (
    lib.db.prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE 1=1${sql}`).get(...params) as {
      n: number
    }
  ).n
  const rows = lib.db
    .prepare(
      `SELECT m.id, m.title, m.created_at, m.status,
              ${lib.hasFolders ? 'f.name' : 'NULL'} AS folder_name,
              (m.enhanced_md IS NOT NULL AND m.enhanced_md != '') AS has_enhanced
         FROM meetings m ${folderJoin(lib)}
        WHERE 1=1${sql}
        ORDER BY ${opts.byTitle ? 'm.title COLLATE NOCASE' : 'm.created_at DESC'}
        LIMIT ?`
    )
    .all(...params, opts.byTitle ? Math.min(total, OUTLINE_SORT_CAP) : opts.limit) as unknown as {
    id: string
    title: string
    created_at: number
    status: string
    folder_name: string | null
    has_enhanced: number
  }[]
  let out = rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    folderName: r.folder_name,
    status: r.status,
    hasEnhanced: r.has_enhanced === 1
  }))
  if (opts.byTitle) {
    // SQLite's COLLATE NOCASE is lexicographic, so a numbered syllabus comes
    // back 2.2.1, 2.2.10, 2.2.11, 2.2.4 — not reading order, which is the one
    // thing this ordering exists to provide. Intl numeric collation compares
    // digit runs as numbers.
    out = out.sort((a, b) => TITLE_COLLATOR.compare(a.title, b.title)).slice(0, opts.limit)
  }
  return { rows: out, total }
}

/** Rows pulled before the numeric re-sort. The sort has to happen over the
 *  whole filtered set, not the first page, or the page boundary lands in the
 *  wrong place. */
const OUTLINE_SORT_CAP = 2000

const TITLE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export interface TopicGroup {
  key: string
  notes: number
  chars: number
  folders: { name: string; notes: number }[]
  sample: string
}

/** Group notes by the leading numeric segment of their title.
 *
 *  This is the grouping a course library actually has, and no other axis
 *  reaches it. Folders do not: in this library 8 of the 46 topic-2 notes were
 *  never filed, including the largest, so a folder-scoped answer silently
 *  drops a third of the reading. Full-text search does not either, because
 *  "2.1.4" tokenizes into unrelated numbers. The prefix is the structure. */
export function topicGroups(lib: Library, folderRef: ResolvedFolder | null): TopicGroup[] {
  const { sql, params } = buildFilters(lib, {}, folderRef)
  const rows = lib.db
    .prepare(
      `SELECT m.title,
              ${lib.hasFolders ? 'f.name' : 'NULL'} AS folder_name,
              LENGTH(COALESCE(m.enhanced_md, '')) + LENGTH(COALESCE(m.notes_json, '')) AS chars
         FROM meetings m ${folderJoin(lib)}
        WHERE 1=1${sql}`
    )
    .all(...params) as unknown as { title: string; folder_name: string | null; chars: number }[]

  const groups = new Map<string, { notes: number; chars: number; folders: Map<string, number>; sample: string }>()
  for (const r of rows) {
    const m = /^\s*(?:topic\s*)?(\d+)[.\s]/i.exec(r.title)
    const key = m ? m[1] : '(unnumbered)'
    let g = groups.get(key)
    if (!g) {
      g = { notes: 0, chars: 0, folders: new Map(), sample: r.title }
      groups.set(key, g)
    }
    g.notes += 1
    g.chars += r.chars
    const fname = r.folder_name ?? '(unfiled)'
    g.folders.set(fname, (g.folders.get(fname) ?? 0) + 1)
    if (TITLE_COLLATOR.compare(r.title, g.sample) < 0) g.sample = r.title
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      notes: g.notes,
      chars: g.chars,
      folders: [...g.folders.entries()]
        .map(([name, notes]) => ({ name, notes }))
        .sort((a, b) => b.notes - a.notes),
      sample: g.sample
    }))
    .sort((a, b) => TITLE_COLLATOR.compare(a.key, b.key))
}

export function getNote(lib: Library, id: string): NoteContent | null {
  const row = lib.db
    .prepare(
      `SELECT ${metaColumns(lib)}, m.notes_json, m.enhanced_md, m.enhanced_at
         FROM meetings m ${folderJoin(lib)}
        WHERE m.id = ?`
    )
    .get(id) as
    | (RawMeta & { notes_json: string; enhanced_md: string | null; enhanced_at: number | null })
    | undefined
  if (!row) return null
  return {
    ...toMeta(row),
    notesJson: row.notes_json,
    enhancedMd: row.enhanced_md,
    enhancedAt: row.enhanced_at
  }
}

/** Ids beginning with `prefix`. Lets a model pass the short id it saw in a
 *  previous result without having to echo all 36 characters exactly. */
export function findNoteIdsByPrefix(lib: Library, prefix: string, limit = 5): string[] {
  return (
    lib.db
      .prepare("SELECT id FROM meetings WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
      .all(`${escapeLike(prefix)}%`, limit) as unknown as { id: string }[]
  ).map((r) => r.id)
}

/** Title matches, for the "no note with that id" message. */
export function findNotesByTitle(lib: Library, text: string, limit = 5): NoteMeta[] {
  // An empty needle makes the pattern '%%', which matches every note — so a
  // blank id came back as "did you mean" plus the five newest notes, as though
  // they were somehow relevant.
  if (text.trim() === '') return []
  const rows = lib.db
    .prepare(
      `SELECT ${metaColumns(lib)}
         FROM meetings m ${folderJoin(lib)}
        WHERE m.title LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(`%${escapeLike(text)}%`, limit) as unknown as RawMeta[]
  return rows.map(toMeta)
}

export function countSegments(lib: Library, meetingId: string): number {
  return (
    lib.db
      .prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE meeting_id = ?')
      .get(meetingId) as { n: number }
  ).n
}

export function getSegments(
  lib: Library,
  meetingId: string,
  offset: number,
  limit: number
): SegmentRow[] {
  const rows = lib.db
    .prepare(
      `SELECT id, channel, text, start_ms, speaker FROM transcript_segments
        WHERE meeting_id = ? ORDER BY start_ms, id LIMIT ? OFFSET ?`
    )
    .all(meetingId, limit, offset) as unknown as {
    id: number
    channel: 'mic' | 'system'
    text: string
    start_ms: number
    speaker: number | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    text: r.text,
    startMs: r.start_ms,
    speaker: r.speaker
  }))
}

/** User-assigned speaker names for one note, keyed by speakerKey(). Empty on a
 *  library predating the roster tables, which makes every caller's speakerLabel
 *  fall back to the generated label — the same output this server produced
 *  before names existed. */
export function speakerNames(lib: Library, meetingId: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!lib.hasSpeakerRoster) return map
  const rows = lib.db
    .prepare(
      `SELECT k.channel AS channel, k.speaker AS speaker, i.name AS name
         FROM speaker_keys k
         JOIN speaker_identities i ON i.id = k.identity_id
        WHERE k.meeting_id = ? AND i.name IS NOT NULL AND i.name <> ''`
    )
    .all(meetingId) as unknown as { channel: 'mic' | 'system'; speaker: number; name: string }[]
  for (const r of rows) {
    map.set(speakerKey(r.channel, r.speaker === -1 ? null : r.speaker), r.name)
  }
  return map
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

// Filler a natural-language question carries that would drown a real match in
// noise — every note contains "what" and "the". Mirrors the app's own chat
// retrieval so the MCP tools rank the same way the in-app chat does.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'did', 'does', 'what', 'when',
  'who', 'how', 'why', 'where', 'which', 'about', 'with', 'that', 'this',
  'have', 'has', 'had', 'our', 'you', 'your', 'they', 'their', 'them', 'she',
  'his', 'her', 'him', 'can', 'could', 'would', 'should', 'will', 'any',
  'all', 'say', 'said', 'tell', 'told', 'get', 'got', 'meeting', 'meetings',
  'note', 'notes',
  // Closed-class words, kept explicit rather than filtered by length so that
  // short but load-bearing terms — "AI", "Q3", "K8s" — still search.
  'we', 'us', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'or', 'if',
  'do', 'so', 'as', 'an', 'by', 'my', 'me', 'up', 'but', 'not', 'from',
  'into', 'over', 'been', 'than', 'then', 'also', 'just', 'like', 'there'
])

/** Words to search for. Control characters are stripped rather than escaped:
 *  inside SQLite they truncate the query string outright. */
export function queryTerms(query: string): string[] {
  const all = query
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
  // A bare digit is meaningful here — "topic 2" and "topic 3" are different
  // questions, and dropping single characters made them the same query.
  const meaningful = all.filter(
    (t) => (t.length >= 2 || /^\d$/.test(t)) && !STOPWORDS.has(t.toLowerCase())
  )
  // A question made entirely of stopwords ("what did they say") still deserves
  // an attempt rather than an empty result.
  const kept = meaningful.length > 0 ? meaningful : all
  // Repeating a term ("one on one") adds a clause and skews nothing but the
  // ranking, which then degenerates to whatever order the index yields.
  const seen = new Set<string>()
  return kept.filter((t) => {
    const k = t.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Spelled-out numbers, mapped to digits. A course library names its notes
 *  "2.1.4 …" while a person asks about "topic two", and FTS has no idea those
 *  are the same thing. */
const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10'
}

function ftsQuoted(t: string): string {
  return `"${t.replace(/"/g, '""')}"*`
}

function ftsTerm(t: string): string {
  const digit = NUMBER_WORDS[t.toLowerCase()]
  if (!digit) return ftsQuoted(t)
  // Two deliberate narrowings, both learned from this library:
  //  - no prefix glob on the digit. "2"* matches 2, 20, 25, 2024 and so hits
  //    110 of 130 notes; the exact token "2" is what "topic two" means.
  //  - scoped to the title column. The digit 2 appears in almost every long
  //    transcript, so an unscoped alternative ranks a note that merely says
  //    "two" above the note actually numbered 2.
  return `(${ftsQuoted(t)} OR title:"${digit}")`
}

/** Explicit AND, never juxtaposition. FTS5 accepts `a b` as an implicit AND
 *  only between bare terms — the moment a term becomes a parenthesised
 *  alternation (which the number-word expansion above does), `a (b OR c)` is a
 *  syntax error and `a AND (b OR c)` is required. */
function ftsExpr(terms: string[], op: ' AND ' | ' OR '): string {
  return terms.map(ftsTerm).join(op)
}

/** Column weights for bm25, in declaration order: meeting_id (UNINDEXED, so
 *  its weight is inert but the argument list must be positional), title, body.
 *  A title match is a far stronger signal of what a note *is about* than one
 *  more body mention, and without this a 40-page transcript that says the word
 *  in passing outranks the note actually named for it. */
const BM25_WEIGHTS = '0.0, 10.0, 1.0'

export type MatchMode = 'all' | 'any'

/** Rank notes against a query. Tries every term (precise) and falls back to any
 *  term ranked by bm25 (recall) — a question phrased in the user's words rarely
 *  has all its terms in one note, but a two-word search usually should. */
export function searchNotes(
  lib: Library,
  query: string,
  opts: ListFilters & { limit: number; folderRef?: ResolvedFolder | null }
): { hits: SearchHit[]; total: number; mode: MatchMode; terms: string[] } {
  const terms = queryTerms(query)
  if (terms.length === 0) return { hits: [], total: 0, mode: 'all', terms }
  const { sql, params } = buildFilters(lib, opts, opts.folderRef ?? null)

  /** How many notes the expression matches in total, as opposed to how many
   *  fit on this page. Without it the caller can only report `hits.length`,
   *  which equals the limit whenever there are more matches than room — so a
   *  search over 30 notes announces "8 notes matched" and the truncation is
   *  invisible. */
  const countFor = (expr: string): number =>
    (
      lib.db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM search_fts JOIN meetings m ON m.id = search_fts.meeting_id
            WHERE search_fts MATCH ?${sql}`
        )
        .get(expr, ...params) as { n: number }
    ).n

  const run = (expr: string): SearchHit[] => {
    const rows = lib.db
      .prepare(
        `SELECT ${metaColumns(lib)},
                snippet(search_fts, 2, '«', '»', ' … ', 24) AS snip
           FROM search_fts
           JOIN meetings m ON m.id = search_fts.meeting_id
           ${folderJoin(lib)}
          WHERE search_fts MATCH ?${sql}
          ORDER BY bm25(search_fts, ${BM25_WEIGHTS})
          LIMIT ?`
      )
      .all(expr, ...params, opts.limit) as unknown as (RawMeta & { snip: string })[]
    return rows.map((r) => ({ ...toMeta(r), snippet: r.snip }))
  }

  const allExpr = ftsExpr(terms, ' AND ')
  const all = run(allExpr)
  if (all.length > 0 || terms.length === 1) {
    return { hits: all, total: countFor(allExpr), mode: 'all', terms }
  }
  const anyExpr = ftsExpr(terms, ' OR ')
  return { hits: run(anyExpr), total: countFor(anyExpr), mode: 'any', terms }
}

// ---------------------------------------------------------------------------
// Transcript search
// ---------------------------------------------------------------------------

/** Ceiling on distinct terms in one transcript search. SQLite caps expression
 *  depth at 1000, and one clause per term reaches it long before the query is
 *  meaningful; without this a pasted paragraph returns a raw parser error. */
const MAX_TRANSCRIPT_TERMS = 32

export interface TranscriptHit {
  note: NoteMeta
  /** Index of the matched line within the meeting's transcript. */
  index: number
  line: SegmentRow
  before: SegmentRow[]
  after: SegmentRow[]
}

/** Find spoken lines containing every term. Substring matching, not FTS: the
 *  index is per note, and "who said X" needs the line and its timestamp. A
 *  scan is affordable — the whole segments table is small, and the note filter
 *  usually narrows it to one meeting. */
export function searchTranscript(
  lib: Library,
  query: string,
  opts: {
    limit: number
    contextLines: number
    meetingId?: string
    folderRef?: ResolvedFolder | null
    afterMs?: number
    beforeMs?: number
  }
): { hits: TranscriptHit[]; total: number; terms: string[]; dropped: number } {
  const rawTerms = query
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)

  // Case-fold-dedupe: a repeated term costs a clause and changes nothing, and
  // an uncapped clause list is how a long paste reaches SQLite's "expression
  // tree is too large" instead of an answer.
  const seen = new Set<string>()
  const wanted: string[] = []
  for (const t of rawTerms) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    wanted.push(t)
  }
  const terms = wanted.slice(0, MAX_TRANSCRIPT_TERMS)
  const dropped = wanted.length - terms.length
  if (terms.length === 0) return { hits: [], total: 0, terms, dropped }

  const clauses: string[] = []
  const params: BindValue[] = []
  for (const t of terms) {
    if (/^[A-Za-z0-9]{1,3}$/.test(t)) {
      // Substring matching is right for a long term ("bill" should find
      // "billing") and catastrophic for a short one: LIKE '%ai%' matches said,
      // constraint and gain, burying every real hit — 509 matches in this
      // library against 0 actual uses of the word. Pad the text and anchor on
      // non-alphanumerics so short terms match as whole words. GLOB has a real
      // negated class ([^…]) where LIKE has none; the term is ASCII-only in
      // this branch, so lower() folds it correctly and it cannot smuggle in a
      // GLOB metacharacter.
      clauses.push("(' ' || lower(s.text) || ' ') GLOB ?")
      params.push(`*[^a-z0-9]${t.toLowerCase()}[^a-z0-9]*`)
    } else {
      clauses.push("s.text LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(t)}%`)
    }
  }
  if (opts.meetingId) {
    clauses.push('s.meeting_id = ?')
    params.push(opts.meetingId)
  }
  const { sql: metaSql, params: metaParams } = buildFilters(
    lib,
    { afterMs: opts.afterMs, beforeMs: opts.beforeMs },
    opts.folderRef ?? null
  )

  const where = `WHERE ${clauses.join(' AND ')}${metaSql}`
  const total = (
    lib.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id ${where}`
      )
      .get(...params, ...metaParams) as { n: number }
  ).n

  const rows = lib.db
    .prepare(
      `SELECT s.id, s.meeting_id, s.start_ms
         FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id
         ${where}
        ORDER BY m.created_at DESC, s.start_ms, s.id
        LIMIT ?`
    )
    .all(...params, ...metaParams, opts.limit) as unknown as {
    id: number
    meeting_id: string
    start_ms: number
  }[]

  // Load each matched meeting's transcript once, then locate hits by index —
  // context lines are neighbours in transcript order, which SQL can only give
  // by re-querying per hit.
  const cache = new Map<string, { note: NoteMeta; lines: SegmentRow[] }>()
  const hits: TranscriptHit[] = []
  for (const row of rows) {
    let entry = cache.get(row.meeting_id)
    if (!entry) {
      const note = getNote(lib, row.meeting_id)
      if (!note) continue
      // -1 is SQLite's "no limit"; context lines are neighbours by position, so
      // the whole transcript has to be in hand to index into it.
      entry = { note, lines: getSegments(lib, row.meeting_id, 0, -1) }
      cache.set(row.meeting_id, entry)
    }
    // By row id, not timestamp: two channels regularly open a segment in the
    // same millisecond, and matching on start_ms resolved both hits to the
    // first of the pair — losing one line and printing the other twice.
    const idx = entry.lines.findIndex((l) => l.id === row.id)
    if (idx < 0) continue
    hits.push({
      note: entry.note,
      index: idx,
      line: entry.lines[idx],
      before: entry.lines.slice(Math.max(0, idx - opts.contextLines), idx),
      after: entry.lines.slice(idx + 1, idx + 1 + opts.contextLines)
    })
  }
  return { hits, total, terms, dropped }
}

// ---------------------------------------------------------------------------
// Folders and overview
// ---------------------------------------------------------------------------

export interface FolderCount {
  id: string
  name: string
  createdAt: number
  noteCount: number
}

export function listFoldersWithCounts(lib: Library): {
  folders: FolderCount[]
  unfiled: number
} {
  if (!lib.hasFolders) return { folders: [], unfiled: countAllNotes(lib) }
  const rows = lib.db
    .prepare(
      `SELECT f.id, f.name, f.created_at, COUNT(m.id) AS n
         FROM folders f LEFT JOIN meetings m ON m.folder_id = f.id
        GROUP BY f.id, f.name, f.created_at
        ORDER BY f.name COLLATE NOCASE`
    )
    .all() as unknown as { id: string; name: string; created_at: number; n: number }[]
  const unfiled = (
    lib.db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE folder_id IS NULL').get() as {
      n: number
    }
  ).n
  return {
    folders: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      noteCount: r.n
    })),
    unfiled
  }
}

function countAllNotes(lib: Library): number {
  return (lib.db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n
}

export interface Overview {
  notes: number
  enhanced: number
  withTranscript: number
  segments: number
  recordedMs: number
  oldest: number | null
  newest: number | null
  folders: number
  byStatus: { status: string; n: number }[]
}

export function overview(lib: Library): Overview {
  const db = lib.db
  const base = db
    .prepare(
      `SELECT COUNT(*) AS notes,
              SUM(enhanced_md IS NOT NULL AND enhanced_md != '') AS enhanced,
              MIN(created_at) AS oldest,
              MAX(created_at) AS newest,
              -- Per note, the longer of the wall clock and the transcript's
              -- own span. The clock alone under-reports: the same three notes
              -- duration() was fixed for also skew the library total.
              SUM(MAX(
                CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                     THEN MAX(ended_at - started_at, 0) ELSE 0 END,
                COALESCE((SELECT MAX(s.end_ms) FROM transcript_segments s
                           WHERE s.meeting_id = meetings.id), 0)
              )) AS recorded_ms
         FROM meetings`
    )
    .get() as {
    notes: number
    enhanced: number | null
    oldest: number | null
    newest: number | null
    recorded_ms: number | null
  }
  const segments = (
    db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get() as { n: number }
  ).n
  const withTranscript = (
    db
      .prepare('SELECT COUNT(DISTINCT meeting_id) AS n FROM transcript_segments')
      .get() as { n: number }
  ).n
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM meetings GROUP BY status ORDER BY n DESC')
    .all() as unknown as { status: string; n: number }[]
  const folders = lib.hasFolders
    ? (db.prepare('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n
    : 0
  return {
    notes: base.notes,
    enhanced: base.enhanced ?? 0,
    withTranscript,
    segments,
    recordedMs: base.recorded_ms ?? 0,
    oldest: base.oldest,
    newest: base.newest,
    folders,
    byStatus
  }
}

// ---------------------------------------------------------------------------
// Knowledge graph (schema v10; absent on older libraries)
// ---------------------------------------------------------------------------

export function hasGraph(lib: Library): boolean {
  return tableExists(lib.db, 'entities') && tableExists(lib.db, 'note_entities')
}

export interface EntitySummary {
  name: string
  kind: string
  noteCount: number
  /** Titles (with ids) of the notes carrying it, salience order, capped. */
  notes: { id: string; title: string }[]
}

/** Entities with the notes they tie together, most-connected first. */
export function graphEntities(
  lib: Library,
  folder: ResolvedFolder | null,
  limit: number
): EntitySummary[] {
  if (!hasGraph(lib)) return []
  const folderClause =
    folder === null ? '' : folder.kind === 'unfiled' ? 'AND m.folder_id IS NULL' : 'AND m.folder_id = ?'
  const params: (string | number)[] = folder && folder.kind === 'folder' ? [folder.id!] : []
  const entities = lib.db
    .prepare(
      `SELECT e.id, e.name, e.kind, COUNT(*) AS note_count
         FROM entities e
         JOIN note_entities ne ON ne.entity_id = e.id
         JOIN meetings m ON m.id = ne.meeting_id
        WHERE 1=1 ${folderClause}
        GROUP BY e.id
        ORDER BY note_count DESC, e.name
        LIMIT ?`
    )
    .all(...params, limit) as unknown as {
    id: number
    name: string
    kind: string
    note_count: number
  }[]
  const notesFor = lib.db.prepare(
    `SELECT m.id, m.title FROM note_entities ne
       JOIN meetings m ON m.id = ne.meeting_id
      WHERE ne.entity_id = ? ${folderClause}
      ORDER BY ne.weight DESC LIMIT 12`
  )
  return entities.map((e) => ({
    name: e.name,
    kind: e.kind,
    noteCount: e.note_count,
    notes: (notesFor.all(e.id, ...params) as unknown as { id: string; title: string }[]).map(
      (n) => ({ id: n.id, title: n.title })
    )
  }))
}

export interface RelatedNoteRow {
  id: string
  title: string
  score: number
  shared: string[]
}

/** Separates GROUP_CONCAT parts; entity names can contain commas. */
const NAME_SEP = String.fromCharCode(31)

/** Notes sharing entities with this one, strongest ties first. Mirrors the
 *  app's relatedNotes query (src/main/db/entities.ts). */
export function relatedNotesFor(lib: Library, meetingId: string, limit: number): RelatedNoteRow[] {
  if (!hasGraph(lib)) return []
  const rows = lib.db
    .prepare(
      `SELECT m.id, m.title, SUM(a.weight * b.weight) AS score,
              GROUP_CONCAT(e.name, char(31)) AS shared
         FROM note_entities a
         JOIN note_entities b ON b.entity_id = a.entity_id AND b.meeting_id != a.meeting_id
         JOIN meetings m ON m.id = b.meeting_id
         JOIN entities e ON e.id = a.entity_id
        WHERE a.meeting_id = ?
        GROUP BY b.meeting_id
        ORDER BY score DESC
        LIMIT ?`
    )
    .all(meetingId, limit) as unknown as {
    id: string
    title: string
    score: number
    shared: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
    shared: [...new Set(r.shared.split(NAME_SEP))].slice(0, 6)
  }))
}

/** This note's own extracted entities, most salient first. */
export function entitiesForNote(
  lib: Library,
  meetingId: string
): { name: string; kind: string }[] {
  if (!hasGraph(lib)) return []
  return lib.db
    .prepare(
      `SELECT e.name, e.kind FROM note_entities ne
         JOIN entities e ON e.id = ne.entity_id
        WHERE ne.meeting_id = ? ORDER BY ne.weight DESC, e.name LIMIT 16`
    )
    .all(meetingId) as unknown as { name: string; kind: string }[]
}
