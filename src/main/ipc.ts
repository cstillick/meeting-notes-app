import { Notification, app, dialog, ipcMain } from 'electron'
import { basename } from 'path'
import type { EventMap, InvokeMap } from '@shared/ipc'
import type { SpeakerIdentity } from '@shared/types'
import { getMainWindow, isAppDocument, showMainWindow } from './index'
import { getSettingsView, updateSettings } from './settings'
import { recorder } from './transcription/recorder'
import { enhancer } from './enhance/enhancer'
import { MicMonitor } from './audio/micMonitor'
import { closeDetectPanel, showDetectPanel } from './detectPanel'

// The worklet emits ~50 ms of 16 kHz s16le mono (~1.6 KB); the cap is generous
// headroom, not a tight bound, and only exists to keep a runaway renderer from
// pushing arbitrarily large buffers down the app's highest-frequency channel.
const MAX_PCM_CHUNK_BYTES = 64 * 1024

let micMonitor: MicMonitor | null = null

export function stopMicMonitor(): void {
  micMonitor?.stop()
}
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  saveNotes,
  saveEnhanced,
  saveEnhancedEdit,
  updateTitle
} from './db/meetings'
import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
  setMeetingFolder
} from './db/folders'
import { getSegments } from './db/transcripts'
import {
  clearSpeaker,
  mergeSpeakers,
  setSpeakerIsMe,
  setSpeakerName,
  setSuggestedName,
  speakerRoster
} from './db/speakers'
import { suggestSpeakers } from './speakers/identify'
import { appLog } from './transcription/debugLog'
import { clearChat, getChatHistory } from './db/chats'
import { getDb, takeRecoveredMeetingIds, withTransaction } from './db/database'
import { reindexMeeting, reindexMeetings, searchMeetings } from './db/search'
import { pmToPlainText } from './enhance/prompt'
import { pmToMarkdown } from './enhance/pmToMarkdown'
import { IMPORTABLE_EXTENSIONS, importer } from './transcription/importer'
import { pollCalendarNow } from './calendar'
import { clearEntitiesStamp, graphData, relatedNotes } from './db/entities'
import { initExtractor, scheduleExtract } from './graph/extractor'
import {
  exportFileBase,
  exportJsonToFile,
  exportNoteToFile,
  exportNoteToNotion,
  exportScopeToNotion,
  exportVaultToDir
} from './export'
import { chatService } from './chat/chatService'
import { initEmbedder, scheduleEmbed } from './embeddings/embedder'

/** The preload bridge is injected into whatever document a window ends up
 *  holding, so the channel allowlist alone is not a boundary: a frame that is
 *  not one of ours (a hostile navigation, a remote subframe) must not reach a
 *  handler at all. */
function fromAppDocument(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  try {
    // Reading a disposed frame throws; that call is not from a live app
    // document either way, and mic:pcm has no promise to reject into.
    const url = event.senderFrame?.url
    return typeof url === 'string' && isAppDocument(url)
  } catch {
    return false
  }
}

/** Typed ipcMain.handle wrapper tying handlers to the shared contract. */
export function handle<K extends keyof InvokeMap>(
  channel: K,
  handler: (
    ...args: Parameters<InvokeMap[K]>
  ) => ReturnType<InvokeMap[K]> | Promise<Awaited<ReturnType<InvokeMap[K]>>>
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppDocument(event)) throw new Error(`ipc: ${channel} from an untrusted frame`)
    return handler(...(args as Parameters<InvokeMap[K]>))
  })
}

/** Send a typed event to the main window. Never to every window: auxiliary
 *  windows (the detect panel) would receive transcript and chat payloads they
 *  have no use for. */
export function broadcast<K extends keyof EventMap>(
  channel: K,
  ...args: Parameters<EventMap[K]>
): void {
  getMainWindow()?.webContents.send(channel, ...args)
}

let flushAck: (() => void) | null = null

/** Recording-start request parked for a window that is still loading (events
 *  sent before React attaches listeners are lost) — same pattern as the
 *  detect panel's pendingAutoStart. */
let pendingRecordingStartNoteId: string | null = null

/** Ask the renderer to start recording a specific note. The renderer owns the
 *  start because the microphone is captured there; main only routes. Used by
 *  calendar auto-record and the agent control socket. */
export async function requestRecordingStart(noteId: string): Promise<void> {
  const existing = getMainWindow()
  if (existing) {
    await showMainWindow()
    existing.webContents.send('recording:startRequested', { noteId })
  } else {
    pendingRecordingStartNoteId = noteId
    await showMainWindow()
  }
}

/** Give the renderer a chance to write its debounced editor saves before the
 *  DB closes. app.exit skips pagehide, so quitting without this loses up to
 *  750 ms of note/title/enhanced edits. Bounded: a hung or closed renderer
 *  must never block quit. */
export function flushRenderers(timeoutMs: number): Promise<void> {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushAck = null
      resolve()
    }, timeoutMs)
    flushAck = () => {
      clearTimeout(timer)
      flushAck = null
      resolve()
    }
    broadcast('app:will-quit')
  })
}

export function registerIpc(): void {
  handle('settings:get', () => getSettingsView())
  handle('settings:set', (update) => {
    const view = updateSettings(update)
    // A newly added Voyage key should pick up the un-embedded backlog.
    if (update.voyageKey) scheduleEmbed()
    // Poll right away so the calendar permission prompt appears while the
    // user is still looking at the toggle they just flipped.
    if (update.calendarAutoRecord === true) pollCalendarNow()
    return view
  })

  // Chunk + embed pipeline for semantic chat retrieval (no-op without a
  // Voyage key). Hooks reindexMeeting and backfills pre-existing notes.
  initEmbedder()

  // A hard kill mid-recording (SIGKILL, power loss) commits transcript finals
  // but never reaches the stop-time reindex — and the chunk backfill skips
  // those notes because chunked_at is already set, so their words would stay
  // invisible to search, RAG, and MCP forever. Reindex whatever startup
  // recovery flipped out of a transient status. After initEmbedder so fresh
  // chunks get embedded.
  const recovered = takeRecoveredMeetingIds()
  if (recovered.length > 0) {
    try {
      reindexMeetings(recovered)
      console.log(`startup: reindexed ${recovered.length} meeting(s) recovered from a crash`)
    } catch (err) {
      console.error('startup: reindex of recovered meetings failed', err)
    }
  }

  // Knowledge-graph extraction: drain notes whose entities are missing/stale.
  initExtractor()

  handle('meetings:create', () => createMeeting())
  handle('meetings:list', () => listMeetings())
  handle('meetings:get', (id) => {
    const meeting = getMeeting(id)
    if (!meeting) return null
    return { meeting, segments: getSegments(id), speakers: speakerRoster(id) }
  })
  // Text writes and their reindex commit together (withTransaction): a crash
  // between the two would leave FTS and chunks silently stale, and the chunk
  // backfill never revisits a note whose chunked_at is already set.
  handle('meetings:updateTitle', (id, title) => {
    withTransaction(() => {
      updateTitle(id, title)
      reindexMeeting(id)
    })
  })
  handle('meetings:delete', (id) => deleteMeeting(id))
  handle('meetings:setFolder', (id, folderId) => setMeetingFolder(id, folderId))

  // A rename changes no chunk text — the chunker is never given names — so the
  // reindex here only refreshes the FTS body (which does carry them) and
  // carryEmbeddings matches every existing vector, issuing no embedding calls.
  // The broadcast is what makes a second window showing the note relabel.
  const speakerWrite = (meetingId: string, fn: () => SpeakerIdentity[]): SpeakerIdentity[] => {
    const rows = withTransaction(() => {
      const out = fn()
      reindexMeeting(meetingId)
      return out
    })
    broadcast('library:changed', { noteIds: [meetingId], folders: false })
    return rows
  }

  handle('speakers:setName', (meetingId, channel, speaker, name) =>
    speakerWrite(meetingId, () => setSpeakerName(meetingId, channel, speaker, name))
  )
  handle('speakers:clear', (meetingId, channel, speaker) =>
    speakerWrite(meetingId, () => clearSpeaker(meetingId, channel, speaker))
  )
  handle('speakers:setMe', (meetingId, channel, speaker) =>
    speakerWrite(meetingId, () => setSpeakerIsMe(meetingId, channel, speaker))
  )
  handle('speakers:merge', (meetingId, fromIdentityId, intoIdentityId) =>
    speakerWrite(meetingId, () => mergeSpeakers(meetingId, fromIdentityId, intoIdentityId))
  )
  handle('speakers:accept', (meetingId, channel, speaker, name) =>
    speakerWrite(meetingId, () => setSuggestedName(meetingId, channel, speaker, name))
  )
  // Proposals only — nothing is written until the user accepts one, because a
  // confidently wrong name is worse than no name at all.
  handle('speakers:suggest', async (meetingId) => {
    try {
      return { ok: true, suggestions: await suggestSpeakers(meetingId) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('folders:list', () => listFolders())
  handle('folders:create', (name) => createFolder(name))
  handle('folders:rename', (id, name) => renameFolder(id, name))
  handle('folders:delete', (id) => deleteFolder(id))

  handle('notes:save', (id, notesJson) => {
    // While recording, save the text but defer the reindex to recorder.stop():
    // reindexMeeting re-reads every transcript segment and rewrites the full
    // FTS row, so a long meeting would rewrite its entire transcript into the
    // WAL on every 750 ms autosave while finals stream in. A crash before stop
    // is covered by the startup recovery reindex above.
    if (getMeeting(id)?.status === 'recording') {
      saveNotes(id, notesJson)
      return
    }
    withTransaction(() => {
      saveNotes(id, notesJson)
      reindexMeeting(id)
    })
  })

  handle('enhance:saveResult', (id, enhancedJson, enhancedMd, title) => {
    withTransaction(() => {
      saveEnhanced(id, enhancedJson, enhancedMd, title)
      reindexMeeting(id)
    })
  })

  handle('enhanced:save', (id, enhancedJson) => {
    // Serialized back to real Markdown, not flattened: enhanced_md is the
    // canonical text for MCP get_note, chat excerpts, FTS, and chunking, and
    // no doc→markdown path exists elsewhere — pmToPlainText here destroyed
    // headings and emphasis irreversibly. The title H1 is reattached because
    // the editor doc holds only the body (splitTitle strips the H1 on save).
    const body = pmToMarkdown(enhancedJson) || pmToPlainText(enhancedJson)
    const title = getMeeting(id)?.title.trim()
    const md = title ? `# ${title}\n\n${body}` : body
    withTransaction(() => {
      saveEnhancedEdit(id, enhancedJson, md)
      reindexMeeting(id)
    })
  })

  handle('search:query', (q) => searchMeetings(q))

  handle('export:note', async (noteId, format) => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export note',
      defaultPath: `${exportFileBase(noteId)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    if (picked.canceled || !picked.filePath) return null
    try {
      await exportNoteToFile(noteId, format, picked.filePath)
      return { ok: true, path: picked.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('export:library', async (folderId, kind) => {
    const win = getMainWindow()
    if (!win) return null
    try {
      if (kind === 'json') {
        const picked = await dialog.showSaveDialog(win, {
          title: 'Export JSON bundle',
          defaultPath: 'notetaker-library.json',
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (picked.canceled || !picked.filePath) return null
        exportJsonToFile(folderId, picked.filePath)
        return { ok: true, path: picked.filePath }
      }
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for the Obsidian vault',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory']
      })
      const dir = picked.filePaths[0]
      if (picked.canceled || !dir) return null
      const { files } = exportVaultToDir(folderId, dir)
      return { ok: true, path: dir, files }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('export:notion', async (target) => {
    try {
      if (target.noteId) {
        const page = await exportNoteToNotion(target.noteId)
        return { ok: true, url: page.url, pages: 1 }
      }
      const { container, pages } = await exportScopeToNotion(target.folderId ?? null)
      return { ok: true, url: container.url, pages }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('graph:get', (folderId) => graphData(folderId))
  handle('graph:related', (meetingId) => relatedNotes(meetingId, 8))
  handle('graph:rebuild', () => {
    getDb().exec('UPDATE meetings SET entities_at = NULL')
    scheduleExtract()
  })

  // Dev-only diagnostic: verify stored keys against provider auth endpoints
  // without exposing key material. From DevTools: await window.api.invoke('debug:checkKeys')
  if (process.env['ELECTRON_RENDERER_URL']) {
    ipcMain.handle('debug:checkKeys', async (event) => {
      if (!fromAppDocument(event)) throw new Error('ipc: debug:checkKeys from an untrusted frame')
      const { getDeepgramKey, getAnthropicKey } = await import('./settings')
      const dg = getDeepgramKey()
      const an = getAnthropicKey()
      const out: Record<string, unknown> = {
        deepgram: dg ? { len: dg.length, hasWs: /\s/.test(dg) } : null,
        anthropic: an ? { len: an.length, hasWs: /\s/.test(an) } : null
      }
      if (dg) {
        const r = await fetch('https://api.deepgram.com/v1/auth/token', {
          headers: { Authorization: `Token ${dg}` }
        })
        out['deepgramAuth'] = r.status
      }
      return out
    })
  }

  handle('recorder:start', (meetingId, source) => recorder.start(meetingId, source))
  handle('recorder:stop', () => recorder.stop())

  handle('import:pick', async () => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import recordings',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio & video', extensions: IMPORTABLE_EXTENSIONS }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const started: { noteId: string; file: string }[] = []
    const errors: string[] = []
    for (const filePath of picked.filePaths) {
      try {
        const { meetingId } = importer.start({ filePath })
        started.push({ noteId: meetingId, file: basename(filePath) })
      } catch (err) {
        errors.push(
          `${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return { started, errors }
  })

  // Import progress reaches the renderer as-is; any state change also counts
  // as a library change (a new draft appeared, a transcript landed) so the
  // list and any open view refresh through the one existing path.
  importer.on('status', (status) => {
    broadcast('import:status', status)
    broadcast('library:changed', { noteIds: [status.meetingId], folders: false })
    // A finished import is a new note with entities_at NULL — extract it.
    if (status.state === 'done') scheduleExtract()
  })

  handle('enhance:start', (meetingId) => enhancer.start(meetingId))
  handle('enhance:cancel', () => enhancer.cancel())

  enhancer.on('delta', (d) => broadcast('enhance:delta', d))
  enhancer.on('done', (d) => {
    broadcast('enhance:done', d)
    // A fresh enhancement is the best extraction source — re-extract.
    try {
      clearEntitiesStamp(d.meetingId)
    } catch (err) {
      console.error('graph: clearing extraction stamp failed', err)
    }
    scheduleExtract()
  })
  enhancer.on('error', (d) => broadcast('enhance:error', d))

  handle('chat:send', (req) => chatService.send(req))
  handle('chat:history', (meetingId, folderId) => getChatHistory(meetingId, folderId))
  handle('chat:cancel', (chatKey) => chatService.cancel(chatKey))
  handle('chat:clear', (meetingId, folderId) => clearChat(meetingId, folderId))

  handle('app:flushed', () => {
    flushAck?.()
  })

  // Fire-and-forget like mic:pcm: a throw here has no promise to reject into.
  ipcMain.on('log:error', (event, line: unknown) => {
    if (!fromAppDocument(event)) return
    if (typeof line !== 'string' || line.length === 0) return
    appLog('renderer', line.slice(0, 4000))
  })

  chatService.on('delta', (d) => broadcast('chat:delta', d))
  chatService.on('done', (d) => broadcast('chat:done', d))
  chatService.on('error', (d) => broadcast('chat:error', d))

  // The only ipcMain.on in the app, and the only place a renderer argument
  // reaches native code: the ArrayBuffer annotation is erased, and a throw here
  // has no promise to reject into — it would take down main.
  ipcMain.on('mic:pcm', (event, chunk: unknown) => {
    if (!fromAppDocument(event)) return
    try {
      const buf =
        chunk instanceof ArrayBuffer
          ? Buffer.from(chunk)
          : ArrayBuffer.isView(chunk)
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : null
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_PCM_CHUNK_BYTES) {
        console.warn('ipc: dropped mic:pcm chunk')
        return
      }
      recorder.onMicChunk(buf)
    } catch (err) {
      console.error('ipc: dropped malformed mic:pcm chunk', err)
    }
  })

  recorder.on('segment', (segment) => broadcast('transcript:segment', segment))
  recorder.on('status', (status) => broadcast('recorder:status', status))

  // Meeting detection: when another app starts using the mic and we're not
  // recording, suggest taking notes. Debounce 3s to skip short blips, and
  // suppress while our own capture holds the mic open. Pairs the in-app
  // banner with a system notification so detection reaches the user even
  // when the app is in the background or its window is closed.
  micMonitor = new MicMonitor()
  let debounce: NodeJS.Timeout | null = null
  let detectNotification: Notification | null = null

  const closeDetectNotification = (): void => {
    detectNotification?.close()
    detectNotification = null
    closeDetectPanel()
  }

  let pendingAutoStart = false

  const startFromDetection = (): void => {
    void (async () => {
      const existing = getMainWindow()
      if (existing) {
        await showMainWindow()
        existing.webContents.send('meeting:autoStart')
      } else {
        // A fresh window's React listeners aren't attached at did-finish-load;
        // a send would be lost. The banner pulls this flag once it mounts.
        pendingAutoStart = true
        await showMainWindow()
      }
    })()
  }

  handle('detect:action', (action) => {
    console.log('[detect] panel action:', action)
    closeDetectNotification()
    if (action === 'start') startFromDetection()
  })

  handle('detect:consumePending', () => {
    const pending = pendingAutoStart
    pendingAutoStart = false
    return pending
  })

  handle('recording:consumePendingStart', () => {
    const id = pendingRecordingStartNoteId
    pendingRecordingStartNoteId = null
    return id
  })

  const notifyMeetingDetected = (): void => {
    // The floating panel is the primary surface: system notifications are
    // silently dropped for ad-hoc-signed apps (both dev Electron and the
    // unsigned packaged build), and the dock bounce needs no permission.
    showDetectPanel()
    app.dock?.bounce('informational')
    if (!Notification.isSupported()) return
    detectNotification?.close()
    const notification = new Notification({
      title: 'Meeting detected',
      body: 'Another app is using your microphone. Click to start recording.',
      silent: true
    })
    notification.on('show', () => console.log('[detect] notification shown'))
    notification.on('click', () => {
      console.log('[detect] notification clicked')
      closeDetectNotification()
      startFromDetection()
    })
    notification.show()
    detectNotification = notification
  }

  micMonitor.on('activity', (inUse) => {
    console.log('[detect] mic activity:', inUse)
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    if (inUse) {
      debounce = setTimeout(() => {
        if (!recorder.recording) {
          console.log('[detect] meeting detected — notifying')
          broadcast('mic:activity', { inUse: true })
          notifyMeetingDetected()
        }
      }, 3000)
    } else {
      broadcast('mic:activity', { inUse: false })
      closeDetectNotification()
    }
  })
  micMonitor.start()

  // Once recording starts (from the banner, notification, or manually), the
  // suggestion is moot.
  recorder.on('status', (status) => {
    if (status.state !== 'idle') closeDetectNotification()
  })
}
