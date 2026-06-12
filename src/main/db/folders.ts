import { randomUUID } from 'crypto'
import type { Folder } from '@shared/types'
import { getDb } from './database'

interface FolderRow {
  id: string
  name: string
  created_at: number
}

function toFolder(row: FolderRow): Folder {
  return { id: row.id, name: row.name, createdAt: row.created_at }
}

export function createFolder(name: string): Folder {
  const id = randomUUID()
  const now = Date.now()
  const clean = name.trim() || 'Untitled folder'
  getDb()
    .prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, clean, now)
  return { id, name: clean, createdAt: now }
}

export function getFolder(id: string): Folder | null {
  const row = getDb()
    .prepare('SELECT id, name, created_at FROM folders WHERE id = ?')
    .get(id) as FolderRow | undefined
  return row ? toFolder(row) : null
}

export function listFolders(): Folder[] {
  const rows = getDb()
    .prepare('SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE')
    .all() as unknown as FolderRow[]
  return rows.map(toFolder)
}

export function renameFolder(id: string, name: string): void {
  const clean = name.trim()
  if (!clean) return
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(clean, id)
}

/** Delete a folder. Notes inside it are unfiled (ON DELETE SET NULL), not
 *  removed; the folder's own chat thread is dropped (ON DELETE CASCADE). */
export function deleteFolder(id: string): void {
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id)
}

/** Move a note into a folder, or null to unfile it. */
export function setMeetingFolder(meetingId: string, folderId: string | null): void {
  getDb().prepare('UPDATE meetings SET folder_id = ? WHERE id = ?').run(folderId, meetingId)
}
