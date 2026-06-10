export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meetings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','recording','recorded','enhancing','enhanced')),
  notes_json    TEXT NOT NULL DEFAULT '{}',
  enhanced_json TEXT,
  enhanced_md   TEXT,
  enhanced_at   INTEGER
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('mic','system')),
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_meeting
  ON transcript_segments(meeting_id, start_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  meeting_id UNINDEXED,
  title,
  body
);
`
