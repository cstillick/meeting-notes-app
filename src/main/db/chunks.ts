import { getDb } from './database'
import { carryEmbeddings, chunkSections } from '../embeddings/lib'

export interface ChunkRow {
  id: number
  meeting_id: string
  seq: number
  text: string
  embedding: Uint8Array | null
}

/** Rebuild a note's chunk rows from its current text sources. Embeddings of
 *  unchanged chunks are carried over (matched by text), so steady-state edits
 *  only invalidate the chunks they actually touch. Caller schedules the
 *  embedder for whatever ends up NULL. */
export function rebuildChunks(meetingId: string, sections: string[]): void {
  const db = getDb()
  const prev = db
    .prepare('SELECT text, embedding FROM chunks WHERE meeting_id = ?')
    .all(meetingId) as unknown as { text: string; embedding: Uint8Array | null }[]
  const next = carryEmbeddings(prev, chunkSections(sections))

  // SAVEPOINT (not BEGIN): reindexMeeting's caller may already hold a transaction.
  db.exec('SAVEPOINT chunks')
  try {
    db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId)
    const insert = db.prepare(
      'INSERT INTO chunks (meeting_id, seq, text, embedding) VALUES (?, ?, ?, ?)'
    )
    next.forEach((c, seq) => insert.run(meetingId, seq, c.text, c.embedding))
    db.exec('RELEASE chunks')
  } catch (err) {
    db.exec('ROLLBACK TO chunks')
    db.exec('RELEASE chunks')
    throw err
  }
}

/** Oldest-first batch of chunks still waiting for an embedding. */
export function listUnembeddedChunks(limit: number): Pick<ChunkRow, 'id' | 'text'>[] {
  return getDb()
    .prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?')
    .all(limit) as unknown as Pick<ChunkRow, 'id' | 'text'>[]
}

export function saveChunkEmbedding(id: number, embedding: Uint8Array): void {
  getDb().prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(embedding, id)
}

/** All embedded chunks in scope: one folder's notes, or the whole library. */
export function listEmbeddedChunks(
  folderId: string | null
): Pick<ChunkRow, 'meeting_id' | 'seq' | 'text' | 'embedding'>[] {
  const db = getDb()
  const rows =
    folderId === null
      ? db
          .prepare('SELECT meeting_id, seq, text, embedding FROM chunks WHERE embedding IS NOT NULL')
          .all()
      : db
          .prepare(
            `SELECT c.meeting_id, c.seq, c.text, c.embedding FROM chunks c
               JOIN meetings m ON m.id = c.meeting_id
              WHERE c.embedding IS NOT NULL AND m.folder_id = ?`
          )
          .all(folderId)
  return rows as unknown as Pick<ChunkRow, 'meeting_id' | 'seq' | 'text' | 'embedding'>[]
}

/** Meetings that have never been chunked — startup backfill for notes that
 *  predate the chunks table. (Notes with no text yield zero chunks and are
 *  re-checked each launch; chunking nothing is free.) */
export function listUnchunkedMeetingIds(): string[] {
  const rows = getDb()
    .prepare('SELECT id FROM meetings WHERE id NOT IN (SELECT DISTINCT meeting_id FROM chunks)')
    .all() as unknown as { id: string }[]
  return rows.map((r) => r.id)
}
