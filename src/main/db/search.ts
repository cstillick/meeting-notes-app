import type { MeetingSummary } from '@shared/types'
import { pmToPlainText, type TranscriptLine } from '../enhance/prompt'
import { getDb } from './database'
import { listMeetings } from './meetings'
import { rebuildChunks } from './chunks'

/** Post-reindex hook (set by the embedder at startup) so freshly rebuilt
 *  chunks get embedded without the db layer importing network code. */
let onReindexed: ((meetingId: string) => void) | null = null
export function setOnReindexed(cb: (meetingId: string) => void): void {
  onReindexed = cb
}

/** Extract plain text from ProseMirror JSON (best-effort, for indexing).
 *  Iterative walk: notes_json depth is untrusted, recursion would overflow. */
export function pmToText(json: string): string {
  try {
    const parts: string[] = []
    const stack: unknown[] = [JSON.parse(json)]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      const n = node as { text?: string; content?: unknown[] }
      if (typeof n.text === 'string') parts.push(n.text)
      if (Array.isArray(n.content)) {
        for (let i = n.content.length - 1; i >= 0; i--) stack.push(n.content[i])
      }
    }
    return parts.join(' ')
  } catch (err) {
    console.error('search: failed to extract text from notes_json', err)
    return ''
  }
}

/** Rebuild the FTS row for one meeting from its title, notes, and transcript. */
export function reindexMeeting(meetingId: string): void {
  const db = getDb()
  const meeting = db
    .prepare('SELECT title, notes_json, enhanced_md, fts_rowid FROM meetings WHERE id = ?')
    .get(meetingId) as
    | { title: string; notes_json: string; enhanced_md: string | null; fts_rowid: number | null }
    | undefined
  if (!meeting) return

  const segments = (
    db
      .prepare(
        // ", id" tiebreak: mic and system segments routinely share a start_ms,
        // and an unstable tie order would shift chunk boundaries (invalidating
        // embeddings) between reindexes for no textual reason.
        'SELECT channel, text, start_ms, speaker FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms, id'
      )
      .all(meetingId) as unknown as {
      channel: 'mic' | 'system'
      text: string
      start_ms: number
      speaker: number | null
    }[]
  ).map<TranscriptLine>((r) => ({
    channel: r.channel,
    text: r.text,
    startMs: r.start_ms,
    speaker: r.speaker
  }))

  // FTS gets the flat join: it tokenizes anyway, and timestamp/speaker prefixes
  // would only add junk tokens.
  const body = [
    pmToText(meeting.notes_json),
    meeting.enhanced_md ?? '',
    segments.map((s) => s.text).join(' ')
  ].join(' ')

  // SAVEPOINT (not BEGIN): callers may already hold a transaction.
  db.exec('SAVEPOINT reindex')
  try {
    // By rowid, never by meeting_id: that column is UNINDEXED, so fts5 answers
    // a predicate on it by scanning the entire index.
    if (meeting.fts_rowid !== null) {
      db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(meeting.fts_rowid)
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO search_fts (meeting_id, title, body) VALUES (?, ?, ?)')
      .run(meetingId, meeting.title, body)
    db.prepare('UPDATE meetings SET fts_rowid = ? WHERE id = ?').run(lastInsertRowid, meetingId)
    db.exec('RELEASE reindex')
  } catch (err) {
    db.exec('ROLLBACK TO reindex')
    db.exec('RELEASE reindex')
    throw err
  }

  // Same sources as the FTS body, but structured — line-structured notes and
  // raw segments — so chunks cut on real boundaries and carry attribution. Kept
  // as separate sections so an edit in one never shifts another's boundaries.
  rebuildChunks(meetingId, [pmToPlainText(meeting.notes_json), meeting.enhanced_md ?? ''], segments)
  onReindexed?.(meetingId)
}

/** Reindex a set of notes in one transaction. The startup chunk backfill would
 *  otherwise pay a WAL commit (and fsync) per note. */
export function reindexMeetings(meetingIds: string[]): void {
  if (meetingIds.length === 0) return
  const db = getDb()
  db.exec('SAVEPOINT reindex_batch')
  try {
    for (const id of meetingIds) reindexMeeting(id)
    db.exec('RELEASE reindex_batch')
  } catch (err) {
    db.exec('ROLLBACK TO reindex_batch')
    db.exec('RELEASE reindex_batch')
    throw err
  }
}

// Filler words a natural-language question carries that would drown an FTS
// match in noise (every meeting contains "what", "the", "did"…).
const CHAT_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'did', 'does', 'what', 'when',
  'who', 'how', 'why', 'where', 'which', 'about', 'with', 'that', 'this',
  'have', 'has', 'had', 'our', 'you', 'your', 'they', 'their', 'them', 'she',
  'his', 'her', 'him', 'can', 'could', 'would', 'should', 'will', 'any',
  'all', 'say', 'said', 'tell', 'told', 'get', 'got', 'meeting', 'meetings'
])

/** Rank meetings relevant to a chat question. Unlike searchMeetings (terms
 *  ANDed — right for keyword search, wrong for questions), this ORs the
 *  meaningful terms and ranks by bm25, so "what did we decide about the
 *  redesign budget" still matches a meeting that only mentions "redesign". */
export function searchMeetingIdsForChat(question: string, limit = 6): string[] {
  try {
    const terms = question
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3 && !CHAT_STOPWORDS.has(t.toLowerCase()))
    if (terms.length === 0) return []
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ')
    const rows = getDb()
      .prepare(
        'SELECT meeting_id FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT ?'
      )
      .all(ftsQuery, limit) as unknown as { meeting_id: string }[]
    return rows.map((r) => r.meeting_id)
  } catch (err) {
    console.error('search: chat FTS query failed', err)
    return []
  }
}

export function searchMeetings(query: string): MeetingSummary[] {
  const q = query.trim()
  if (!q) return listMeetings()

  const db = getDb()
  let ids: string[]
  try {
    // Quote each term to keep FTS5 syntax characters from breaking the query.
    // Control chars (incl. NUL) would truncate the query inside SQLite — strip them.
    const ftsQuery = q
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ')
    if (!ftsQuery) return []
    // Ranked, so LIMIT keeps the *best* 100, not an arbitrary 100 in
    // last-reindex order. Weights match the MCP server (title 10×, body 1×;
    // meeting_id is UNINDEXED) so the same query ranks the same everywhere.
    ids = (
      db
        .prepare(
          'SELECT meeting_id FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts, 0.0, 10.0, 1.0) LIMIT 100'
        )
        .all(ftsQuery) as { meeting_id: string }[]
    ).map((r) => r.meeting_id)
  } catch (err) {
    console.error('search: FTS query failed', err)
    ids = []
  }
  if (ids.length === 0) return []

  // Fetch only the matched meetings (not the whole table); display order is
  // relevance order, restored below from the ranked id list.
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, title, created_at, started_at, ended_at, status, folder_id
         FROM meetings WHERE id IN (${placeholders})`
    )
    .all(...ids) as {
    id: string
    title: string
    created_at: number
    started_at: number | null
    ended_at: number | null
    status: MeetingSummary['status']
    folder_id: string | null
  }[]
  const rank = new Map(ids.map((id, i) => [id, i]))
  return rows
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      folderId: r.folder_id
    }))
}
