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
function recoverTransientStatuses(d: DatabaseSync): void {
  d.exec(`
    UPDATE meetings SET status = 'recorded', ended_at = COALESCE(ended_at, started_at)
      WHERE status IN ('recording', 'enhancing');
  `)
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
