// Local control plane for out-of-process agents (the MCP server).
//
// A unix socket in userData, guarded by a per-launch random token written next
// to it with 0600 perms — same trust boundary as the database file itself:
// anything that can read userData already owns the notes. Line-delimited JSON,
// one request per connection.
//
// Today's ops: 'ping' and 'library-changed' (the MCP server wrote notes; the
// app rebuilds chunks for them, re-embeds, and tells the renderer to refresh).
// The recording controls of later phases land here too.
import { randomBytes } from 'crypto'
import { chmodSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createServer, type Server, type Socket } from 'net'
import { app } from 'electron'
import { reindexMeeting, reindexMeetings } from './db/search'
import { listFolders, setMeetingFolder } from './db/folders'
import { createMeeting, getMeeting, updateTitle } from './db/meetings'
import { withTransaction } from './db/database'
import { broadcast, requestRecordingStart } from './ipc'
import { importer } from './transcription/importer'
import { recorder } from './transcription/recorder'
import { scheduleExtract } from './graph/extractor'
import {
  exportJsonToFile,
  exportNoteToFile,
  exportNoteToNotion,
  exportScopeToNotion,
  exportVaultToDir,
  NOTE_EXPORT_FORMATS,
  type NoteExportFormat
} from './export'
import { isAbsolute } from 'path'

const MAX_REQUEST_BYTES = 256 * 1024
/** Bound the per-notify reindex; a runaway caller must not stall main. */
const MAX_NOTE_IDS = 200

let server: Server | null = null
let socketPath: string | null = null
let tokenPath: string | null = null
let token: string | null = null

export interface ControlRequest {
  token?: unknown
  op?: unknown
  change?: unknown
}

export interface LibraryChange {
  noteIds: string[]
  folders: boolean
}

function parseChange(raw: unknown): LibraryChange {
  const c = (raw ?? {}) as { noteIds?: unknown; folders?: unknown }
  const noteIds = Array.isArray(c.noteIds)
    ? c.noteIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100)
        .slice(0, MAX_NOTE_IDS)
    : []
  return { noteIds, folders: c.folders === true }
}

function handleLibraryChanged(change: LibraryChange): void {
  if (change.noteIds.length > 0) {
    try {
      // The MCP writer synced FTS itself but deliberately left chunks
      // invalidated (it has no Voyage key). Reindexing here rebuilds them and
      // the embedder hook schedules the embedding drain. Extraction drains the
      // entities_at NULLs the writer left behind the same way.
      reindexMeetings(change.noteIds)
      scheduleExtract()
    } catch (err) {
      console.error('control: reindex after external write failed', err)
    }
  }
  broadcast('library:changed', change)
}

/** Resolve a folder reference (id, or name case-insensitively) to an id.
 *  Throws with the real names on a miss — the caller relays it to a model. */
function resolveFolderId(ref: unknown): string | null {
  if (ref === undefined || ref === null) return null
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('folder must be a name or id')
  const wanted = ref.trim()
  if (/^(unfiled|none|no folder)$/i.test(wanted)) return null
  const folders = listFolders()
  const hit =
    folders.find((f) => f.id === wanted) ??
    folders.find((f) => f.name.toLowerCase() === wanted.toLowerCase())
  if (!hit) {
    throw new Error(
      `No folder matching "${wanted}". Existing folders: ${
        folders.length ? folders.map((f) => `"${f.name}"`).join(', ') : '(none)'
      }`
    )
  }
  return hit.id
}

function handleImportRecording(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as { path?: unknown; title?: unknown; folder?: unknown }
  if (typeof a.path !== 'string' || !a.path.trim()) {
    return { ok: false, error: 'path is required' }
  }
  try {
    const { meetingId } = importer.start({
      filePath: a.path,
      title: typeof a.title === 'string' ? a.title : undefined,
      folderId: resolveFolderId(a.folder)
    })
    return { ok: true, noteId: meetingId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** An agent asked for a recording. Create the (titled, filed) note now and
 *  hand the actual start to the renderer, which owns the microphone. The
 *  response returns as soon as the note exists — recording spins up over the
 *  next seconds; recording-status is the way to confirm it took. */
function handleStartRecording(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as { title?: unknown; folder?: unknown }
  if (recorder.currentState !== 'idle') {
    return {
      ok: false,
      error: `Already ${recorder.currentState} note ${recorder.currentMeetingId ?? '?'} — one recording at a time. Stop it first.`
    }
  }
  try {
    const folderId = resolveFolderId(a.folder)
    const meeting = createMeeting()
    withTransaction(() => {
      if (typeof a.title === 'string' && a.title.trim()) updateTitle(meeting.id, a.title.trim())
      if (folderId) setMeetingFolder(meeting.id, folderId)
      reindexMeeting(meeting.id)
    })
    broadcast('library:changed', { noteIds: [meeting.id], folders: false })
    void requestRecordingStart(meeting.id)
    return { ok: true, noteId: meeting.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleStopRecording(): Promise<Record<string, unknown>> {
  const noteId = recorder.currentMeetingId
  if (recorder.currentState === 'idle' || !noteId) {
    return { ok: false, error: 'Nothing is being recorded.' }
  }
  await recorder.stop()
  broadcast('library:changed', { noteIds: [noteId], folders: false })
  return { ok: true, noteId }
}

function handleRecordingStatus(): Record<string, unknown> {
  const noteId = recorder.currentMeetingId
  const meeting = noteId ? getMeeting(noteId) : null
  return {
    ok: true,
    state: recorder.currentState,
    noteId,
    title: meeting?.title ?? null,
    startedAt: meeting?.startedAt ?? null
  }
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    throw new Error(`${label} must be an absolute path`)
  }
  return value.trim()
}

async function handleExport(op: string, args: unknown): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as {
    noteId?: unknown
    folder?: unknown
    format?: unknown
    destPath?: unknown
  }
  try {
    switch (op) {
      case 'export-note': {
        if (typeof a.noteId !== 'string' || !a.noteId) throw new Error('noteId is required')
        const format = String(a.format ?? '') as NoteExportFormat
        if (!NOTE_EXPORT_FORMATS.includes(format)) {
          throw new Error(`format must be one of ${NOTE_EXPORT_FORMATS.join(', ')}`)
        }
        const destPath = requireAbsolutePath(a.destPath, 'destPath')
        await exportNoteToFile(a.noteId, format, destPath)
        return { ok: true, path: destPath }
      }
      case 'export-vault': {
        const destPath = requireAbsolutePath(a.destPath, 'destPath')
        const { files } = exportVaultToDir(resolveFolderId(a.folder), destPath)
        return { ok: true, path: destPath, files }
      }
      case 'export-json': {
        const destPath = requireAbsolutePath(a.destPath, 'destPath')
        exportJsonToFile(resolveFolderId(a.folder), destPath)
        return { ok: true, path: destPath }
      }
      case 'export-notion': {
        if (typeof a.noteId === 'string' && a.noteId) {
          const page = await exportNoteToNotion(a.noteId)
          return { ok: true, url: page.url, pages: 1 }
        }
        const { container, pages } = await exportScopeToNotion(resolveFolderId(a.folder))
        return { ok: true, url: container.url, pages }
      }
      default:
        return { ok: false, error: `unknown export op: ${op}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Dispatch one parsed request; the response is one JSON line. */
async function dispatch(req: ControlRequest & { args?: unknown }): Promise<Record<string, unknown>> {
  if (typeof req.token !== 'string' || req.token !== token) {
    return { ok: false, error: 'bad token' }
  }
  switch (req.op) {
    case 'ping':
      return { ok: true, pid: process.pid }
    case 'library-changed':
      handleLibraryChanged(parseChange(req.change))
      return { ok: true }
    case 'import-recording':
      return handleImportRecording(req.args)
    case 'start-recording':
      return handleStartRecording(req.args)
    case 'stop-recording':
      return handleStopRecording()
    case 'recording-status':
      return handleRecordingStatus()
    case 'export-note':
    case 'export-vault':
    case 'export-json':
    case 'export-notion':
      return handleExport(req.op, req.args)
    default:
      return { ok: false, error: `unknown op: ${String(req.op)}` }
  }
}

function handleConnection(socket: Socket): void {
  let buffer = ''
  socket.setTimeout(5_000, () => socket.destroy())
  socket.on('error', () => {
    // Client went away mid-request; nothing to clean up.
  })
  socket.on('data', (data) => {
    buffer += data.toString('utf8')
    if (buffer.length > MAX_REQUEST_BYTES) {
      socket.destroy()
      return
    }
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline)
    buffer = ''
    void (async () => {
      let response: Record<string, unknown>
      try {
        response = await dispatch(JSON.parse(line) as ControlRequest)
      } catch (err) {
        response = {
          ok: false,
          error: err instanceof Error ? err.message : 'malformed request'
        }
      }
      socket.end(`${JSON.stringify(response)}\n`)
    })()
  })
}

export function startControlServer(): void {
  const dir = app.getPath('userData')
  socketPath = join(dir, 'control.sock')
  tokenPath = join(dir, 'control.token')
  token = randomBytes(16).toString('hex')
  writeFileSync(tokenPath, token, { mode: 0o600 })

  server = createServer(handleConnection)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && socketPath) {
      // Stale socket from a crashed run — the single-instance lock guarantees
      // no live app holds it.
      try {
        unlinkSync(socketPath)
        server?.listen(socketPath!, onListening)
        return
      } catch {
        // fall through to the log below
      }
    }
    console.error('control: server error', err)
  })
  server.listen(socketPath, onListening)
}

function onListening(): void {
  if (!socketPath) return
  try {
    chmodSync(socketPath, 0o600)
  } catch {
    // perms are advisory here; the token is the gate
  }
  console.log(`control: listening on ${socketPath}`)
}

export function stopControlServer(): void {
  server?.close()
  server = null
  token = null
  for (const p of [socketPath, tokenPath]) {
    if (!p) continue
    try {
      unlinkSync(p)
    } catch {
      // already gone
    }
  }
  socketPath = null
  tokenPath = null
}
