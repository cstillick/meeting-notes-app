export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

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

/** Versioned migrations, run once each (tracked via PRAGMA user_version). */
export const MIGRATIONS: string[] = [
  // v1: dedupe transcript segments (Deepgram retransmits inserted duplicates
  // before the unique index existed), then enforce uniqueness going forward.
  `
  DELETE FROM transcript_segments WHERE id NOT IN (
    SELECT MIN(id) FROM transcript_segments
    GROUP BY meeting_id, channel, start_ms, end_ms, text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_unique
    ON transcript_segments(meeting_id, channel, start_ms, end_ms, text);
  `,
  // v2: per-speaker diarization on the system channel. The unique index must
  // treat NULL speakers as equal (SQLite considers NULLs distinct in unique
  // indexes), so it indexes COALESCE(speaker, -1) — otherwise mic rows would
  // lose retransmit dedupe.
  `
  ALTER TABLE transcript_segments ADD COLUMN speaker INTEGER;
  DROP INDEX IF EXISTS idx_segments_unique;
  CREATE UNIQUE INDEX idx_segments_unique
    ON transcript_segments(meeting_id, channel, start_ms, end_ms, text, COALESCE(speaker, -1));
  `,
  // v3: persisted AI chat threads. meeting_id NULL = the one global
  // (cross-meeting) thread asked from the home view.
  `
  CREATE TABLE chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_chat_meeting ON chat_messages(meeting_id, id);
  `,
  // v4: note folders. A note may sit in one folder (folder_id NULL = unfiled);
  // deleting a folder unfiles its notes (SET NULL) rather than deleting them.
  // chat_messages gains folder_id for the per-folder thread: meeting_id and
  // folder_id both NULL = the global thread. Added columns must default NULL
  // for ALTER TABLE ... ADD COLUMN with a REFERENCES clause to be legal.
  `
  CREATE TABLE folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE meetings ADD COLUMN folder_id TEXT
    REFERENCES folders(id) ON DELETE SET NULL;
  CREATE INDEX idx_meetings_folder ON meetings(folder_id);
  ALTER TABLE chat_messages ADD COLUMN folder_id TEXT
    REFERENCES folders(id) ON DELETE CASCADE;
  CREATE INDEX idx_chat_folder ON chat_messages(folder_id, id);
  `,
  // v5: semantic retrieval for cross-note chat. Each note's text (rough notes,
  // enhanced notes, transcript) is split into ~1.6K-char chunks; embedding is a
  // little-endian float32 BLOB filled in lazily by the embedder (NULL until
  // embedded, or while no Voyage key is set). Rebuilt on every reindex.
  `
  CREATE TABLE chunks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    embedding  BLOB,
    UNIQUE(meeting_id, seq)
  );
  `
]
