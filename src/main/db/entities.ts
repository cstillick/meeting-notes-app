import type { GraphData, GraphNode, RelatedNote } from '@shared/types'
import { getDb } from './database'

export interface ExtractedEntity {
  name: string
  kind: 'concept' | 'person' | 'organization' | 'topic'
  /** Salience of the entity within the note, 0–1. */
  weight: number
}

/** Dedup key: case/whitespace-insensitive. "fiscal policy" and "Fiscal
 *  Policy " are one entity; the first-seen display name wins. */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Replace one note's extracted entities. Upserts the entity rows, rewrites
 *  the note's links, stamps entities_at, and prunes entities no note carries
 *  any more (extraction churn would otherwise accrete orphans forever). */
export function saveNoteEntities(meetingId: string, extracted: ExtractedEntity[]): void {
  const db = getDb()
  db.exec('SAVEPOINT entities')
  try {
    db.prepare('DELETE FROM note_entities WHERE meeting_id = ?').run(meetingId)
    const upsert = db.prepare(
      `INSERT INTO entities (name, norm, kind) VALUES (?, ?, ?)
         ON CONFLICT(norm) DO UPDATE SET kind = excluded.kind
         RETURNING id`
    )
    const link = db.prepare(
      'INSERT OR REPLACE INTO note_entities (meeting_id, entity_id, weight) VALUES (?, ?, ?)'
    )
    for (const e of extracted) {
      const name = e.name.trim()
      if (!name) continue
      const norm = normalizeEntityName(name)
      const { id } = upsert.get(name, norm, e.kind) as { id: number }
      link.run(meetingId, id, Math.min(1, Math.max(0, e.weight)))
    }
    db.prepare('DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM note_entities)').run()
    db.prepare('UPDATE meetings SET entities_at = ? WHERE id = ?').run(Date.now(), meetingId)
    db.exec('RELEASE entities')
  } catch (err) {
    db.exec('ROLLBACK TO entities')
    db.exec('RELEASE entities')
    throw err
  }
}

/** Mark a note's extraction stale so the drain re-runs it. */
export function clearEntitiesStamp(meetingId: string): void {
  getDb().prepare('UPDATE meetings SET entities_at = NULL WHERE id = ?').run(meetingId)
}

/** Notes whose extraction is missing or stale, oldest first. */
export function listUnextractedMeetingIds(limit: number): string[] {
  const rows = getDb()
    .prepare('SELECT id FROM meetings WHERE entities_at IS NULL ORDER BY created_at LIMIT ?')
    .all(limit) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

export function listEntitiesForNote(
  meetingId: string
): { name: string; kind: string; weight: number }[] {
  return getDb()
    .prepare(
      `SELECT e.name, e.kind, ne.weight FROM note_entities ne
         JOIN entities e ON e.id = ne.entity_id
        WHERE ne.meeting_id = ? ORDER BY ne.weight DESC, e.name`
    )
    .all(meetingId) as unknown as { name: string; kind: string; weight: number }[]
}

/** The bipartite graph (notes + entities, weighted links), optionally scoped
 *  to one folder. Entities appearing on a single note are noise in the visual
 *  graph, so include them only when they belong to the scoped folder view or
 *  carry high salience — the caller filters by degree if it wants stricter. */
export function graphData(folderId: string | null): GraphData {
  const db = getDb()
  const noteFilter = folderId === null ? '' : 'AND m.folder_id = ?'
  const params: string[] = folderId === null ? [] : [folderId]

  const notes = db
    .prepare(
      `SELECT m.id, m.title, m.folder_id, COUNT(ne.entity_id) AS degree
         FROM meetings m JOIN note_entities ne ON ne.meeting_id = m.id
        WHERE 1=1 ${noteFilter}
        GROUP BY m.id`
    )
    .all(...params) as unknown as {
    id: string
    title: string
    folder_id: string | null
    degree: number
  }[]

  const entities = db
    .prepare(
      `SELECT e.id, e.name, e.kind, COUNT(*) AS degree
         FROM entities e
         JOIN note_entities ne ON ne.entity_id = e.id
         JOIN meetings m ON m.id = ne.meeting_id
        WHERE 1=1 ${noteFilter}
        GROUP BY e.id`
    )
    .all(...params) as unknown as { id: number; name: string; kind: string; degree: number }[]

  const links = db
    .prepare(
      `SELECT ne.meeting_id, ne.entity_id, ne.weight
         FROM note_entities ne JOIN meetings m ON m.id = ne.meeting_id
        WHERE 1=1 ${noteFilter}`
    )
    .all(...params) as unknown as { meeting_id: string; entity_id: number; weight: number }[]

  return {
    nodes: [
      ...notes.map<GraphNode>((n) => ({
        id: `n:${n.id}`,
        label: n.title || 'Untitled note',
        kind: 'note',
        folderId: n.folder_id,
        degree: n.degree
      })),
      ...entities.map<GraphNode>((e) => ({
        id: `e:${e.id}`,
        label: e.name,
        kind: e.kind as GraphNode['kind'],
        degree: e.degree
      }))
    ],
    links: links.map((l) => ({
      source: `n:${l.meeting_id}`,
      target: `e:${l.entity_id}`,
      weight: l.weight
    }))
  }
}

/** Notes related to one note through shared entities, strongest ties first.
 *  Score sums the products of the two notes' salience for each shared entity;
 *  `shared` names the shared concepts so a caller can say WHY; char(31) as
 *  the separator because entity names can contain commas. */
export function relatedNotes(meetingId: string, limit: number): RelatedNote[] {
  const rows = getDb()
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
    shared: [...new Set(r.shared.split('\u001f'))].slice(0, 6)
  }))
}

/** How much of the library the graph covers — mirrors embeddingCoverage. */
export function entityCoverage(): { total: number; extracted: number } {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS total, COUNT(entities_at) AS extracted FROM meetings'
    )
    .get() as { total: number; extracted: number }
  return row
}
