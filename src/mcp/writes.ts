// Write operations for the MCP server: create/update/delete notes and folders.
//
// Design:
// - Reads keep using the long-lived read-only handle in db.ts. Every write op
//   opens its own short-lived writable handle, does one BEGIN IMMEDIATE
//   transaction, and closes — the server never holds a write lock while idle,
//   and a read-only environment still serves the read tools.
// - Writes maintain the FTS index inline (mirroring src/main/db/search.ts:
//   same body composition, same delete-by-rowid discipline) so search_notes
//   and the in-app search box see the change immediately.
// - Chunks are NOT rebuilt here: embeddings need the Voyage key, which is
//   safeStorage-encrypted and main-process-only. Instead the note's chunk rows
//   are deleted and chunked_at cleared — stale chunk text must not linger in
//   RAG — and the app rebuilds + embeds on its startup backfill
//   (listUnchunkedMeetingIds) or immediately when the change notification
//   below reaches a running app.
// - Deletes are two-step: the first call returns a confirmation token and a
//   summary of what would be lost; only the token makes the second call act.
import { randomBytes, randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Library } from './db.ts'
import { pmToText } from './pm.ts'

/** Writes assume the full current schema (folders v4 … knowledge graph v10).
 *  Older libraries must be migrated by the app, which owns migrations. */
const REQUIRED_SCHEMA_VERSION = 10

export function openWrite(lib: Library): DatabaseSync {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(lib.path)
  } catch (err) {
    throw new Error(
      `The library at ${lib.path} could not be opened for writing (${
        err instanceof Error ? err.message : String(err)
      }). Reads still work.`
    )
  }
  try {
    // Per-connection pragmas: CASCADE/SET NULL on deletes need foreign_keys,
    // which SQLite defaults to OFF on every fresh connection.
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (version < REQUIRED_SCHEMA_VERSION) {
      throw new Error(
        `This library's schema (v${version}) is older than the write tools require (v${REQUIRED_SCHEMA_VERSION}). Open the Granola Clone app once to migrate it.`
      )
    }
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

/** Run one write transaction. BEGIN IMMEDIATE takes the write lock up front so
 *  the transaction can never hit a busy-upgrade deadlock mid-way. */
export function withWrite<T>(lib: Library, fn: (db: DatabaseSync) => T): T {
  const db = openWrite(lib)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn(db)
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Index maintenance (mirrors src/main/db/search.ts)
// ---------------------------------------------------------------------------

/** Rebuild the FTS row for one meeting on the write handle. Body composition
 *  matches the app's reindexMeeting: notes text + enhanced markdown + joined
 *  transcript. Chunks are invalidated (rows deleted, chunked_at NULL) rather
 *  than rebuilt — see the module header. */
export function syncNoteIndexes(db: DatabaseSync, meetingId: string): void {
  const meeting = db
    .prepare('SELECT title, notes_json, enhanced_md, fts_rowid FROM meetings WHERE id = ?')
    .get(meetingId) as
    | { title: string; notes_json: string; enhanced_md: string | null; fts_rowid: number | null }
    | undefined
  if (!meeting) return
  const segments = db
    .prepare('SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms, id')
    .all(meetingId) as unknown as { text: string }[]
  // Twin of the body built in src/main/db/search.ts — same composition, same
  // conditional tail, so a note indexed here and one reindexed by the app are
  // byte-identical. Assigned speaker names are the tail; a note this server
  // creates has none, but the shape must still match.
  // The gate above admits a v10 library, which predates the roster tables — so
  // probe rather than assume, exactly as openLibrary does for folders.
  const hasRoster = !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'speaker_identities'")
    .get()
  const names = hasRoster
    ? (db
        .prepare(
          `SELECT DISTINCT name FROM speaker_identities
            WHERE meeting_id = ? AND name IS NOT NULL AND name <> ''`
        )
        .all(meetingId) as unknown as { name: string }[])
    : []
  const body = [
    pmToText(meeting.notes_json),
    meeting.enhanced_md ?? '',
    segments.map((s) => s.text).join(' '),
    ...(names.length > 0 ? [names.map((n) => n.name).join(' ')] : [])
  ].join(' ')
  if (meeting.fts_rowid !== null) {
    db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(meeting.fts_rowid)
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO search_fts (meeting_id, title, body) VALUES (?, ?, ?)')
    .run(meetingId, meeting.title, body)
  db.prepare('UPDATE meetings SET fts_rowid = ? WHERE id = ?').run(lastInsertRowid, meetingId)
  db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId)
  // NULL stamps hand the expensive work to the app: chunked_at drives the
  // chunk/embedding backfill, entities_at the knowledge-graph extraction.
  db.prepare('UPDATE meetings SET chunked_at = NULL, entities_at = NULL WHERE id = ?').run(
    meetingId
  )
}

// ---------------------------------------------------------------------------
// Change notification → the running app (best-effort)
// ---------------------------------------------------------------------------

export interface LibraryChange {
  noteIds?: string[]
  folders?: boolean
}

/** Tell a running app what changed so it refreshes its views, rebuilds chunks,
 *  and re-embeds. Fire-and-forget: when the app is closed the socket is
 *  absent and the startup backfill covers the same ground. Never throws and
 *  never blocks the tool result. */
export function notifyApp(lib: Library, change: LibraryChange): void {
  try {
    const dir = dirname(lib.path)
    const token = readFileSync(join(dir, 'control.token'), 'utf8').trim()
    if (!token) return
    const socket = connect(join(dir, 'control.sock'))
    const bail = setTimeout(() => socket.destroy(), 1000)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, op: 'library-changed', change })}\n`)
      socket.end()
    })
    socket.on('error', () => clearTimeout(bail))
    socket.on('close', () => clearTimeout(bail))
  } catch {
    // No token file, no socket, no running app — the backfill handles it.
  }
}

// ---------------------------------------------------------------------------
// Confirmation tokens for destructive tools
// ---------------------------------------------------------------------------

const CONFIRM_TTL_MS = 5 * 60_000

interface PendingDelete {
  kind: 'note' | 'folder'
  id: string
  expires: number
}

const pendingDeletes = new Map<string, PendingDelete>()

export function issueConfirmToken(kind: 'note' | 'folder', id: string): string {
  // One pending delete per target: re-asking replaces the old token.
  for (const [t, p] of pendingDeletes) {
    if (p.kind === kind && p.id === id) pendingDeletes.delete(t)
  }
  const token = randomBytes(8).toString('hex')
  pendingDeletes.set(token, { kind, id, expires: Date.now() + CONFIRM_TTL_MS })
  return token
}

/** Consume a token. Valid once, for the exact target it was issued for. */
export function consumeConfirmToken(token: string, kind: 'note' | 'folder', id: string): boolean {
  const pending = pendingDeletes.get(token.trim())
  if (!pending) return false
  pendingDeletes.delete(token.trim())
  return pending.kind === kind && pending.id === id && pending.expires >= Date.now()
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface CreateNoteResult {
  id: string
  title: string
}

export function createNote(
  lib: Library,
  args: { title: string; folderId: string | null; notesJson: string }
): CreateNoteResult {
  const id = randomUUID()
  withWrite(lib, (db) => {
    db.prepare(
      "INSERT INTO meetings (id, title, created_at, status, notes_json, folder_id) VALUES (?, ?, ?, 'draft', ?, ?)"
    ).run(id, args.title, Date.now(), args.notesJson, args.folderId)
    syncNoteIndexes(db, id)
  })
  notifyApp(lib, { noteIds: [id], folders: args.folderId !== null })
  return { id, title: args.title }
}

export function updateNote(
  lib: Library,
  args: {
    id: string
    title?: string
    notesJson?: string
    /** undefined = leave folder alone; null = unfile; string = folder id. */
    folderId?: string | null
  }
): void {
  withWrite(lib, (db) => {
    if (args.title !== undefined) {
      db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(args.title, args.id)
    }
    if (args.notesJson !== undefined) {
      db.prepare('UPDATE meetings SET notes_json = ? WHERE id = ?').run(args.notesJson, args.id)
    }
    if (args.folderId !== undefined) {
      db.prepare('UPDATE meetings SET folder_id = ? WHERE id = ?').run(args.folderId, args.id)
    }
    if (args.title !== undefined || args.notesJson !== undefined) {
      syncNoteIndexes(db, args.id)
    }
  })
  notifyApp(lib, { noteIds: [args.id], folders: args.folderId !== undefined })
}

export function deleteNote(lib: Library, id: string): void {
  withWrite(lib, (db) => {
    // search_fts has no FK; delete by the rowid the meeting row carries.
    const row = db.prepare('SELECT fts_rowid FROM meetings WHERE id = ?').get(id) as
      | { fts_rowid: number | null }
      | undefined
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    if (row?.fts_rowid != null) {
      db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(row.fts_rowid)
    }
  })
  notifyApp(lib, { noteIds: [id], folders: true })
}

export function createFolder(lib: Library, name: string): { id: string; name: string } {
  const id = randomUUID()
  withWrite(lib, (db) => {
    db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(
      id,
      name,
      Date.now()
    )
  })
  notifyApp(lib, { folders: true })
  return { id, name }
}

export function renameFolder(lib: Library, id: string, name: string): void {
  withWrite(lib, (db) => {
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
  })
  notifyApp(lib, { folders: true })
}

/** Notes in the folder are unfiled (folder_id SET NULL), never deleted; the
 *  folder's chat thread cascades away. Matches the in-app delete semantics. */
export function deleteFolder(lib: Library, id: string): void {
  withWrite(lib, (db) => {
    db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  })
  notifyApp(lib, { folders: true })
}
