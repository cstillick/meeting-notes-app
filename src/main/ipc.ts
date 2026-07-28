import { Notification, app, ipcMain } from 'electron'
import type { EventMap, InvokeMap } from '@shared/ipc'
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
import { appLog } from './transcription/debugLog'
import { clearChat, getChatHistory } from './db/chats'
import { reindexMeeting, searchMeetings } from './db/search'
import { pmToPlainText } from './enhance/prompt'
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
    return view
  })

  // Chunk + embed pipeline for semantic chat retrieval (no-op without a
  // Voyage key). Hooks reindexMeeting and backfills pre-existing notes.
  initEmbedder()

  handle('meetings:create', () => createMeeting())
  handle('meetings:list', () => listMeetings())
  handle('meetings:get', (id) => {
    const meeting = getMeeting(id)
    if (!meeting) return null
    return { meeting, segments: getSegments(id) }
  })
  handle('meetings:updateTitle', (id, title) => {
    updateTitle(id, title)
    reindexMeeting(id)
  })
  handle('meetings:delete', (id) => deleteMeeting(id))
  handle('meetings:setFolder', (id, folderId) => setMeetingFolder(id, folderId))

  handle('folders:list', () => listFolders())
  handle('folders:create', (name) => createFolder(name))
  handle('folders:rename', (id, name) => renameFolder(id, name))
  handle('folders:delete', (id) => deleteFolder(id))

  handle('notes:save', (id, notesJson) => {
    saveNotes(id, notesJson)
    reindexMeeting(id)
  })

  handle('enhance:saveResult', (id, enhancedJson, enhancedMd, title) => {
    saveEnhanced(id, enhancedJson, enhancedMd, title)
    reindexMeeting(id)
  })

  handle('enhanced:save', (id, enhancedJson) => {
    // Line-structured, not flattened: chunking and excerpts read enhanced_md as
    // markdown, and a manual edit must not destroy that structure.
    saveEnhancedEdit(id, enhancedJson, pmToPlainText(enhancedJson))
    reindexMeeting(id)
  })

  handle('search:query', (q) => searchMeetings(q))

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

  handle('recorder:start', (meetingId) => recorder.start(meetingId))
  handle('recorder:stop', () => recorder.stop())

  handle('enhance:start', (meetingId) => enhancer.start(meetingId))
  handle('enhance:cancel', () => enhancer.cancel())

  enhancer.on('delta', (d) => broadcast('enhance:delta', d))
  enhancer.on('done', (d) => broadcast('enhance:done', d))
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
