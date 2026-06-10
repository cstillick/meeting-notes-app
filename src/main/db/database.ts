// Uses Electron's bundled Node built-in SQLite (node:sqlite, Node 24+):
// no native module, no Electron-ABI rebuilds. FTS5 is compiled in.
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA } from './schema'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(join(app.getPath('userData'), 'granola-clone.db'))
  db.exec(SCHEMA)
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
