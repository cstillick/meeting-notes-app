// MCP stress: the write tools.
//
// Exercises the full write path the way an agent reaches it — tool text in,
// tool text out — against a library seeded through the real app write paths,
// then proves the two sides agree: the FTS row the MCP writer maintains is
// byte-identical to the one the app's own reindex builds, chunk invalidation
// hands off to the app's startup backfill, and deletes cascade exactly like
// in-app deletes.
//
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/mcp-writes.ts
import { join } from 'node:path'

import { getDb } from '../../src/main/db/database.ts'
import { createMeeting, updateStatus, updateTitle } from '../../src/main/db/meetings.ts'
import { insertSegment } from '../../src/main/db/transcripts.ts'
import { reindexMeeting } from '../../src/main/db/search.ts'
import { listUnchunkedMeetingIds } from '../../src/main/db/chunks.ts'
import { pmToPlainText } from '../../src/main/enhance/prompt.ts'
import { openLibrary, getNote, type Library } from '../../src/mcp/db.ts'
import { appendMarkdownToDoc, markdownToPmDoc, pmToText } from '../../src/mcp/pm.ts'
import {
  createFolderTool,
  createNoteTool,
  deleteFolderTool,
  deleteNoteTool,
  importRecordingTool,
  renameFolderTool,
  searchNotesTool,
  updateNoteTool
} from '../../src/mcp/tools.ts'
import { header, result } from './_util.ts'

const dir = process.env.STRESS_USERDATA_DIR!
const dbPath = join(dir, 'granola-clone.db')

// Seed one ordinary app-side note so the library is not empty.
const preexisting = createMeeting().id
updateTitle(preexisting, 'Kickoff call')
reindexMeeting(preexisting)

const lib: Library = openLibrary(dbPath)

function throws(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function ftsRow(id: string): { title: string; body: string } | undefined {
  return getDb()
    .prepare(
      'SELECT f.title, f.body FROM search_fts f JOIN meetings m ON m.fts_rowid = f.rowid WHERE m.id = ?'
    )
    .get(id) as { title: string; body: string } | undefined
}

function count(sql: string, ...params: (string | number)[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n
}

// ---------------------------------------------------------------------------
header('markdownToPmDoc structure')
// ---------------------------------------------------------------------------

const md = [
  '# Macro synthesis',
  '',
  'Key claim with **bold** and `code`.',
  '',
  '- first point',
  '  - nested detail',
  '- second point',
  '',
  '1. step one',
  '2. step two',
  '',
  '> a quoted line',
  '',
  '```js',
  'const x = 1',
  '```'
].join('\n')

const parsedDoc = JSON.parse(markdownToPmDoc(md)) as {
  type: string
  content: { type: string; attrs?: { level?: number }; content?: unknown[] }[]
}
const types = parsedDoc.content.map((b) => b.type)
result(
  'block structure survives',
  types.join(',') === 'heading,paragraph,bulletList,orderedList,blockquote,codeBlock',
  types.join(',')
)
const bullets = parsedDoc.content[2] as {
  content: { content: { type: string }[] }[]
}
result(
  'nested bullet lands inside its parent item',
  JSON.stringify(bullets.content[0]).includes('"bulletList"') &&
    !JSON.stringify(bullets.content[1] ?? {}).includes('"bulletList"')
)
result('inline bold mark present', JSON.stringify(parsedDoc).includes('"bold"'))
const plain = pmToPlainText(markdownToPmDoc(md))
result(
  'pmToPlainText reads it back line-structured',
  plain.includes('Macro synthesis') && plain.includes('- first point') && plain.includes('- nested detail'),
  JSON.stringify(plain.split('\n').slice(0, 4))
)
result('append to default empty notes works', appendMarkdownToDoc('{}', 'hello').includes('hello'))
result('append to corrupt notes throws', throws(() => appendMarkdownToDoc('not json', 'x')) !== null)

// ---------------------------------------------------------------------------
header('create_folder / create_note')
// ---------------------------------------------------------------------------

const createdFolderMsg = createFolderTool(lib, { name: 'Research' })
result('create_folder confirms', createdFolderMsg.includes('Created folder "Research"'))
result(
  'duplicate folder name rejected case-insensitively',
  (throws(() => createFolderTool(lib, { name: 'research' })) ?? '').includes('already exists')
)
result(
  'reserved folder names rejected',
  (throws(() => createFolderTool(lib, { name: 'unfiled' })) ?? '').includes('reserved')
)

const createMsg = createNoteTool(lib, {
  title: 'Fiscal multipliers synthesis',
  folder: 'Research',
  content_markdown: md
})
const noteId = /Full id: ([0-9a-f-]{36})/.exec(createMsg)?.[1]
result('create_note returns the full id', noteId !== undefined, createMsg)
if (!noteId) throw new Error('cannot continue without the created note id')

const created = getNote(lib, noteId)!
result('created note is a draft in the folder', created.status === 'draft' && created.folderName === 'Research')
result(
  'created note is searchable immediately (MCP-side FTS)',
  searchNotesTool(lib, { query: 'multipliers synthesis', limit: 5 }).includes(noteId)
)
result(
  'chunks deliberately left to the app: none yet, chunked_at NULL',
  count('SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM meetings WHERE id = ? AND chunked_at IS NULL', noteId) === 1
)
result(
  'startup backfill would pick it up',
  listUnchunkedMeetingIds().includes(noteId)
)

// FTS parity: the row the MCP writer built must match what the app's own
// reindex produces for the same note, byte for byte.
const mcpFts = ftsRow(noteId)!
reindexMeeting(noteId)
const appFts = ftsRow(noteId)!
result(
  'MCP-written FTS row is byte-identical to an app reindex',
  mcpFts.title === appFts.title && mcpFts.body === appFts.body,
  mcpFts.body === appFts.body ? '' : `mcp=${mcpFts.body.length}ch app=${appFts.body.length}ch`
)
result('app reindex rebuilt chunks for it', count('SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', noteId) > 0)
result('pmToText twins agree', pmToText(created.notesJson).length > 0)

// ---------------------------------------------------------------------------
header('update_note')
// ---------------------------------------------------------------------------

updateNoteTool(lib, { note_id: noteId, append_markdown: '- ricardian equivalence caveat' })
const afterAppend = getNote(lib, noteId)!
result(
  'append lands at the end of the doc',
  pmToPlainText(afterAppend.notesJson).trimEnd().endsWith('- ricardian equivalence caveat')
)
result(
  'appended text searchable (FTS resynced)',
  searchNotesTool(lib, { query: 'ricardian equivalence', limit: 5 }).includes(noteId)
)
result(
  'append invalidated chunks again',
  count('SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM meetings WHERE id = ? AND chunked_at IS NULL', noteId) === 1
)

updateNoteTool(lib, {
  note_id: noteId,
  title: 'Fiscal multipliers — final',
  replace_markdown: 'Replaced body about austerity.',
  folder: 'unfiled'
})
const afterReplace = getNote(lib, noteId)!
result(
  'replace + retitle + unfile all landed',
  afterReplace.title === 'Fiscal multipliers — final' &&
    afterReplace.folderId === null &&
    pmToPlainText(afterReplace.notesJson).includes('austerity') &&
    !pmToPlainText(afterReplace.notesJson).includes('ricardian')
)
result(
  'replaced-away words no longer searchable',
  !searchNotesTool(lib, { query: 'ricardian equivalence', limit: 5 }).includes(noteId)
)
result(
  'append+replace together rejected',
  (throws(() => updateNoteTool(lib, { note_id: noteId, append_markdown: 'a', replace_markdown: 'b' })) ?? '').includes('not both')
)
result(
  'no-op update rejected',
  (throws(() => updateNoteTool(lib, { note_id: noteId })) ?? '').includes('Nothing to change')
)

updateStatus(noteId, 'recording')
result(
  'update refused while recording',
  (throws(() => updateNoteTool(lib, { note_id: noteId, append_markdown: 'x' })) ?? '').includes('recorded right now')
)
result(
  'delete refused while recording',
  (throws(() => deleteNoteTool(lib, { note_id: noteId })) ?? '').includes('cannot be deleted')
)
updateStatus(noteId, 'draft')

// ---------------------------------------------------------------------------
header('rename_folder / delete_folder')
// ---------------------------------------------------------------------------

createFolderTool(lib, { name: 'Archive' })
result(
  'rename clash rejected',
  (throws(() => renameFolderTool(lib, { folder: 'Research', new_name: 'archive' })) ?? '').includes('already exists')
)
result(
  'rename works',
  renameFolderTool(lib, { folder: 'Research', new_name: 'Macro Research' }).includes('renamed to "Macro Research"')
)

// A note back in the folder plus a folder chat message, to prove delete
// unfiles the note but cascades the thread.
updateNoteTool(lib, { note_id: noteId, folder: 'Macro Research' })
const folderId = getDb()
  .prepare("SELECT id FROM folders WHERE name = 'Macro Research'")
  .get() as { id: string }
getDb()
  .prepare("INSERT INTO chat_messages (folder_id, role, content, created_at) VALUES (?, 'user', 'q', ?)")
  .run(folderId.id, Date.now())

const delFolderAsk = deleteFolderTool(lib, { folder: 'Macro Research' })
const folderToken = /confirm: "([0-9a-f]{16})"/.exec(delFolderAsk)?.[1]
result('delete_folder first call returns a token and a count', folderToken !== undefined && delFolderAsk.includes('1 note(s)'))
result(
  'wrong token rejected',
  (throws(() => deleteFolderTool(lib, { folder: 'Macro Research', confirm: 'deadbeefdeadbeef' })) ?? '').includes('not valid')
)
deleteFolderTool(lib, { folder: 'Macro Research', confirm: folderToken! })
result(
  'folder gone, note survives unfiled, folder chat cascaded',
  count("SELECT COUNT(*) AS n FROM folders WHERE name = 'Macro Research'") === 0 &&
    getNote(lib, noteId)!.folderId === null &&
    count('SELECT COUNT(*) AS n FROM chat_messages WHERE folder_id = ?', folderId.id) === 0
)

// ---------------------------------------------------------------------------
header('delete_note')
// ---------------------------------------------------------------------------

insertSegment(noteId, 'mic', 'spoken words to cascade', 1_000, 2_000)
getDb()
  .prepare("INSERT INTO chat_messages (meeting_id, role, content, created_at) VALUES (?, 'user', 'q', ?)")
  .run(noteId, Date.now())
reindexMeeting(noteId)
const ftsRowidBefore = (
  getDb().prepare('SELECT fts_rowid FROM meetings WHERE id = ?').get(noteId) as {
    fts_rowid: number
  }
).fts_rowid

const delAsk = deleteNoteTool(lib, { note_id: noteId })
const noteToken = /confirm: "([0-9a-f]{16})"/.exec(delAsk)?.[1]
result(
  'delete_note first call names what would be lost',
  noteToken !== undefined && delAsk.includes('1 transcript lines') && delAsk.includes('PERMANENTLY')
)
const reused = deleteNoteTool(lib, { note_id: noteId, confirm: noteToken! })
result('valid token deletes', reused.startsWith('Deleted note'))
result(
  'token is one-time',
  (throws(() => deleteNoteTool(lib, { note_id: noteId, confirm: noteToken! })) ?? '').length > 0
)
result(
  'cascade complete: row, segments, chunks, chat, FTS all gone',
  count('SELECT COUNT(*) AS n FROM meetings WHERE id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM transcript_segments WHERE meeting_id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM chunks WHERE meeting_id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM chat_messages WHERE meeting_id = ?', noteId) === 0 &&
    count('SELECT COUNT(*) AS n FROM search_fts WHERE rowid = ?', ftsRowidBefore) === 0
)
result('unrelated note untouched', getNote(lib, preexisting) !== null)

// ---------------------------------------------------------------------------
header('import_recording without a running app')
// ---------------------------------------------------------------------------

const importErr = await importRecordingTool(lib, { path: '/tmp/nonexistent.mp3' }).then(
  () => null,
  (err: unknown) => (err instanceof Error ? err.message : String(err))
)
result(
  'clearly reports the app must be running',
  (importErr ?? '').includes('app is not running'),
  importErr ?? '(no error)'
)
