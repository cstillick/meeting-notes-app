import { randomUUID } from 'crypto'
import type { Meeting, MeetingStatus, MeetingSummary } from '@shared/types'
import { getDb } from './database'

interface MeetingRow {
  id: string
  title: string
  created_at: number
  started_at: number | null
  ended_at: number | null
  status: MeetingStatus
  folder_id: string | null
  notes_json: string
  enhanced_json: string | null
  enhanced_md: string | null
  enhanced_at: number | null
}

function toMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    folderId: row.folder_id,
    notesJson: row.notes_json,
    enhancedJson: row.enhanced_json,
    enhancedMd: row.enhanced_md,
    enhancedAt: row.enhanced_at
  }
}

type SummaryRow = Pick<
  MeetingRow,
  'id' | 'title' | 'created_at' | 'started_at' | 'ended_at' | 'status' | 'folder_id'
>

function toSummary(r: SummaryRow): MeetingSummary {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    folderId: r.folder_id
  }
}

const SUMMARY_COLS = 'id, title, created_at, started_at, ended_at, status, folder_id'

export function createMeeting(): Meeting {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO meetings (id, title, created_at) VALUES (?, ?, ?)')
    .run(id, '', now)
  return getMeeting(id)!
}

export function getMeeting(id: string): Meeting | null {
  const row = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as
    | MeetingRow
    | undefined
  return row ? toMeeting(row) : null
}

export function listMeetings(): MeetingSummary[] {
  const rows = getDb()
    .prepare(`SELECT ${SUMMARY_COLS} FROM meetings ORDER BY created_at DESC`)
    .all() as unknown as SummaryRow[]
  return rows.map(toSummary)
}

/** Notes in one folder, newest first. Used to scope folder chat retrieval. */
export function listMeetingsInFolder(folderId: string): MeetingSummary[] {
  const rows = getDb()
    .prepare(`SELECT ${SUMMARY_COLS} FROM meetings WHERE folder_id = ? ORDER BY created_at DESC`)
    .all(folderId) as unknown as SummaryRow[]
  return rows.map(toSummary)
}

export function updateTitle(id: string, title: string): void {
  getDb().prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
}

export function updateStatus(id: string, status: MeetingStatus): void {
  getDb().prepare('UPDATE meetings SET status = ? WHERE id = ?').run(status, id)
}

export function setStarted(id: string, startedAt: number): void {
  getDb()
    .prepare("UPDATE meetings SET started_at = ?, status = 'recording' WHERE id = ?")
    .run(startedAt, id)
}

export function setEnded(id: string, endedAt: number): void {
  getDb()
    .prepare("UPDATE meetings SET ended_at = ?, status = 'recorded' WHERE id = ?")
    .run(endedAt, id)
}

export function saveNotes(id: string, notesJson: string): void {
  getDb().prepare('UPDATE meetings SET notes_json = ? WHERE id = ?').run(notesJson, id)
}

export function saveEnhanced(
  id: string,
  enhancedJson: string,
  enhancedMd: string,
  title?: string
): void {
  const db = getDb()
  db.prepare(
    "UPDATE meetings SET enhanced_json = ?, enhanced_md = ?, enhanced_at = ?, status = 'enhanced' WHERE id = ?"
  ).run(enhancedJson, enhancedMd, Date.now(), id)
  if (title) {
    // Only auto-title meetings the user hasn't titled themselves
    db.prepare("UPDATE meetings SET title = ? WHERE id = ? AND title = ''").run(title, id)
  }
}

export function deleteMeeting(id: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    db.prepare('DELETE FROM search_fts WHERE meeting_id = ?').run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
