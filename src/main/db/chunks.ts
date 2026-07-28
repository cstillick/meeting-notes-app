import type { TranscriptLine } from '../enhance/prompt'
import { getDb } from './database'
import { carryEmbeddings, chunkNote, EMBED_MODEL } from '../embeddings/lib'

export interface ChunkRow {
  id: number
  meeting_id: string
  seq: number
  text: string
  embedding: Uint8Array | null
  model: string | null
  dim: number | null
}

/** Rebuild a note's chunk rows from its current text sources. Embeddings of
 *  unchanged chunks are carried over (matched by text), so steady-state edits
 *  only invalidate the chunks they actually touch. Only the rows that actually
 *  differ are written: a delete-and-reinsert would rewrite every chunk's vector
 *  BLOB into the WAL on every 750ms autosave. Caller schedules the embedder for
 *  whatever ends up NULL. */
export function rebuildChunks(
  meetingId: string,
  sections: string[],
  transcript: TranscriptLine[]
): void {
  const db = getDb()
  const prev = db
    .prepare('SELECT seq, text, embedding, model FROM chunks WHERE meeting_id = ? ORDER BY seq')
    .all(meetingId) as unknown as {
    seq: number
    text: string
    embedding: Uint8Array | null
    model: string | null
  }[]
  const next = carryEmbeddings(prev, chunkNote(sections, transcript), EMBED_MODEL)
  const bySeq = new Map(prev.map((p) => [p.seq, p]))
  const maxSeq = prev.length > 0 ? prev[prev.length - 1].seq : -1

  // SAVEPOINT (not BEGIN): reindexMeeting's caller may already hold a transaction.
  db.exec('SAVEPOINT chunks')
  try {
    if (maxSeq >= next.length) {
      db.prepare('DELETE FROM chunks WHERE meeting_id = ? AND seq >= ?').run(meetingId, next.length)
    }
    const update = db.prepare(
      'UPDATE chunks SET text = ?, embedding = ?, model = ?, dim = ? WHERE meeting_id = ? AND seq = ?'
    )
    const insert = db.prepare(
      'INSERT INTO chunks (meeting_id, seq, text, embedding, model, dim) VALUES (?, ?, ?, ?, ?, ?)'
    )
    next.forEach((c, seq) => {
      const model = c.embedding ? EMBED_MODEL : null
      const dim = c.embedding ? c.embedding.byteLength / 4 : null
      const before = bySeq.get(seq)
      if (!before) {
        insert.run(meetingId, seq, c.text, c.embedding, model, dim)
      } else if (before.text !== c.text || (before.embedding === null) !== (c.embedding === null)) {
        update.run(c.text, c.embedding, model, dim, meetingId, seq)
      }
    })
    db.prepare('UPDATE meetings SET chunked_at = ? WHERE id = ?').run(Date.now(), meetingId)
    db.exec('RELEASE chunks')
  } catch (err) {
    db.exec('ROLLBACK TO chunks')
    db.exec('RELEASE chunks')
    throw err
  }
}

/** Oldest-first batch of chunks still waiting for an embedding. Served by the
 *  partial index on (id) WHERE embedding IS NULL, so the embedder's probe after
 *  every save costs the rows it returns, not the size of the table. */
export function listUnembeddedChunks(limit: number): Pick<ChunkRow, 'id' | 'text'>[] {
  return getDb()
    .prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?')
    .all(limit) as unknown as Pick<ChunkRow, 'id' | 'text'>[]
}

/** One transaction for the whole batch: per-row autocommits cost a WAL fsync
 *  each, 64 of them per embedding batch. */
export function saveChunkEmbeddings(
  rows: { id: number; embedding: Uint8Array }[],
  model: string
): void {
  if (rows.length === 0) return
  const db = getDb()
  db.exec('SAVEPOINT embed_batch')
  try {
    const update = db.prepare('UPDATE chunks SET embedding = ?, model = ?, dim = ? WHERE id = ?')
    for (const r of rows) update.run(r.embedding, model, r.embedding.byteLength / 4, r.id)
    db.exec('RELEASE embed_batch')
  } catch (err) {
    db.exec('ROLLBACK TO embed_batch')
    db.exec('RELEASE embed_batch')
    throw err
  }
}

/** Drop vectors made by a different embedding model so the ordinary drain
 *  re-makes them. They are otherwise permanent dead weight: listUnembeddedChunks
 *  only ever sees NULLs, and cosineTopK skips vectors whose dimension doesn't
 *  match the query — a same-dimension model swap is worse still, scoring
 *  against a query from a different embedding space. Returns rows cleared. */
export function clearStaleEmbeddings(model: string): number {
  const { changes } = getDb()
    .prepare(
      'UPDATE chunks SET embedding = NULL, model = NULL, dim = NULL WHERE embedding IS NOT NULL AND model IS NOT ?'
    )
    .run(model)
  return Number(changes)
}

/** How much of the library is actually retrievable by semantic search — a
 *  silently-degraded index looks identical to a healthy one from the UI. */
export function embeddingCoverage(): { total: number; embedded: number } {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM chunks')
    .get() as { total: number; embedded: number }
  return { total: row.total, embedded: row.embedded }
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
 *  predate the chunks table or the current chunker. Keyed on chunked_at, not on
 *  the absence of chunk rows: an empty note yields zero chunks, so the old
 *  probe re-selected (and re-indexed) it on every launch, forever. */
export function listUnchunkedMeetingIds(): string[] {
  const rows = getDb()
    .prepare('SELECT id FROM meetings WHERE chunked_at IS NULL')
    .all() as unknown as { id: string }[]
  return rows.map((r) => r.id)
}
