import type { MeetingSummary } from '@shared/types'
import { getDb } from './database'
import { listMeetings } from './meetings'

/** Extract plain text from ProseMirror JSON (best-effort, for indexing). */
function pmToText(json: string): string {
  try {
    const parts: string[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as { text?: string; content?: unknown[] }
      if (typeof n.text === 'string') parts.push(n.text)
      if (Array.isArray(n.content)) n.content.forEach(walk)
    }
    walk(JSON.parse(json))
    return parts.join(' ')
  } catch {
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

  db.prepare('DELETE FROM search_fts WHERE meeting_id = ?').run(meetingId)
  db.prepare('INSERT INTO search_fts (meeting_id, title, body) VALUES (?, ?, ?)').run(
    meetingId,
    meeting.title,
    body
  )
}

export function searchMeetings(query: string): MeetingSummary[] {
  const q = query.trim()
  if (!q) return listMeetings()

  const db = getDb()
  let ids: string[]
  try {
    // Quote each term to keep FTS5 syntax characters from breaking the query
    const ftsQuery = q
      .split(/\s+/)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ')
    ids = (
      db
        .prepare('SELECT meeting_id FROM search_fts WHERE search_fts MATCH ? LIMIT 100')
        .all(ftsQuery) as { meeting_id: string }[]
    ).map((r) => r.meeting_id)
  } catch {
    ids = []
  }
  if (ids.length === 0) return []

  const all = listMeetings()
  const rank = new Map(ids.map((id, i) => [id, i]))
  return all
    .filter((m) => rank.has(m.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
}
