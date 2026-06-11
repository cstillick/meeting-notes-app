import type { MeetingSummary } from '@shared/types'
import { getDb } from './database'
import { listMeetings } from './meetings'

/** Extract plain text from ProseMirror JSON (best-effort, for indexing).
 *  Iterative walk: notes_json depth is untrusted, recursion would overflow. */
function pmToText(json: string): string {
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
    .prepare('SELECT title, notes_json, enhanced_md FROM meetings WHERE id = ?')
    .get(meetingId) as { title: string; notes_json: string; enhanced_md: string | null } | undefined
  if (!meeting) return

  const transcript = (
    db
      .prepare('SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms')
      .all(meetingId) as { text: string }[]
  )
    .map((r) => r.text)
    .join(' ')

  const body = [pmToText(meeting.notes_json), meeting.enhanced_md ?? '', transcript].join(' ')

  // SAVEPOINT (not BEGIN): callers may already hold a transaction.
  db.exec('SAVEPOINT reindex')
  try {
    db.prepare('DELETE FROM search_fts WHERE meeting_id = ?').run(meetingId)
    db.prepare('INSERT INTO search_fts (meeting_id, title, body) VALUES (?, ?, ?)').run(
      meetingId,
      meeting.title,
      body
    )
    db.exec('RELEASE reindex')
  } catch (err) {
    db.exec('ROLLBACK TO reindex')
    db.exec('RELEASE reindex')
    throw err
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
    ids = (
      db
        .prepare('SELECT meeting_id FROM search_fts WHERE search_fts MATCH ? LIMIT 100')
        .all(ftsQuery) as { meeting_id: string }[]
    ).map((r) => r.meeting_id)
  } catch (err) {
    console.error('search: FTS query failed', err)
    ids = []
  }
  if (ids.length === 0) return []

  // Fetch only the matched meetings (not the whole table), newest first.
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, title, created_at, started_at, ended_at, status
         FROM meetings WHERE id IN (${placeholders})
        ORDER BY created_at DESC`
    )
    .all(...ids) as {
    id: string
    title: string
    created_at: number
    started_at: number | null
    ended_at: number | null
    status: MeetingSummary['status']
  }[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status
  }))
}
