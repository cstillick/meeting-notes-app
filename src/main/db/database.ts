// Uses Electron's bundled Node built-in SQLite (node:sqlite, Node 24+):
// no native module, no Electron-ABI rebuilds. FTS5 is compiled in.
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA, MIGRATIONS } from './schema'

let db: DatabaseSync | null = null

function runMigrations(d: DatabaseSync): void {
  const { user_version: version } = d
    .prepare('PRAGMA user_version')
    .get() as { user_version: number }
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN')
    try {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
      d.exec('COMMIT')
    } catch (err) {
      d.exec('ROLLBACK')
      throw err
    }
  }
}

/** A crash or force-quit can strand meetings in a transient status. */
let recoveredMeetingIds: string[] = []

function recoverTransientStatuses(d: DatabaseSync): void {
  const rows = d
    .prepare("SELECT id FROM meetings WHERE status IN ('recording', 'enhancing')")
    .all() as unknown as { id: string }[]
  if (rows.length === 0) return
  d.exec(`
    UPDATE meetings SET status = 'recorded', ended_at = COALESCE(ended_at, started_at)
      WHERE status IN ('recording', 'enhancing');
  `)
  recoveredMeetingIds = rows.map((r) => r.id)
}

/** Meetings the last startup flipped out of a transient status. A hard kill
 *  mid-recording commits its transcript finals but never reaches the stop-time
 *  reindex, and the chunk backfill skips anything with chunked_at already set —
 *  so those words would stay invisible to search and RAG forever unless the
 *  caller reindexes them now. Drains on read. */
export function takeRecoveredMeetingIds(): string[] {
  getDb()
  const ids = recoveredMeetingIds
  recoveredMeetingIds = []
  return ids
}

/** Run writes atomically. SAVEPOINT (not BEGIN) so calls nest — reindexMeeting
 *  and rebuildChunks open savepoints of their own inside this. Without an
 *  enclosing transaction a text update and its reindex are separate commits,
 *  and a crash between them leaves FTS and chunks silently stale (the backfill
 *  never revisits: chunked_at is already set). */
export function withTransaction<T>(fn: () => T): T {
  const d = getDb()
  d.exec('SAVEPOINT tx')
  try {
    const out = fn()
    d.exec('RELEASE tx')
    return out
  } catch (err) {
    d.exec('ROLLBACK TO tx')
    d.exec('RELEASE tx')
    throw err
  }
}

export function getDb(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(join(app.getPath('userData'), 'granola-clone.db'))
  db.exec(SCHEMA)
  runMigrations(db)
  recoverTransientStatuses(db)
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
