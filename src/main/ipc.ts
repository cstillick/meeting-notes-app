import { BrowserWindow, Notification, app, ipcMain } from 'electron'
import type { EventMap, InvokeMap } from '@shared/ipc'
import { getSettingsView, updateSettings } from './settings'
import { recorder } from './transcription/recorder'
import { enhancer } from './enhance/enhancer'
import { MicMonitor } from './audio/micMonitor'
import { closeDetectPanel, showDetectPanel } from './detectPanel'

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
  updateTitle
} from './db/meetings'
import { getSegments } from './db/transcripts'
import { reindexMeeting, searchMeetings } from './db/search'

/** Typed ipcMain.handle wrapper tying handlers to the shared contract. */
export function handle<K extends keyof InvokeMap>(
  channel: K,
  handler: (...args: Parameters<InvokeMap[K]>) => ReturnType<InvokeMap[K]>
): void {
  ipcMain.handle(channel, (_event, ...args) =>
    handler(...(args as Parameters<InvokeMap[K]>))
  )
}

/** Broadcast a typed event to all renderer windows. */
export function broadcast<K extends keyof EventMap>(
  channel: K,
  ...args: Parameters<EventMap[K]>
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

export function registerIpc(): void {
  handle('settings:get', () => getSettingsView())
  handle('settings:set', (update) => updateSettings(update))

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

  handle('notes:save', (id, notesJson) => {
    saveNotes(id, notesJson)
    reindexMeeting(id)
  })

  handle('enhance:saveResult', (id, enhancedJson, enhancedMd, title) => {
    saveEnhanced(id, enhancedJson, enhancedMd, title)
    reindexMeeting(id)
  })

  handle('search:query', (q) => searchMeetings(q))

  // Dev-only diagnostic: verify stored keys against provider auth endpoints
  // without exposing key material. From DevTools: await window.api.invoke('debug:checkKeys')
  if (process.env['ELECTRON_RENDERER_URL']) {
    ipcMain.handle('debug:checkKeys', async () => {
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

  ipcMain.handle('recorder:start', (_e, meetingId: string) => recorder.start(meetingId))
  ipcMain.handle('recorder:stop', () => recorder.stop())

  handle('enhance:start', (meetingId) => enhancer.start(meetingId))
  handle('enhance:cancel', () => enhancer.cancel())

  enhancer.on('delta', (d) => broadcast('enhance:delta', d))
  enhancer.on('done', (d) => broadcast('enhance:done', d))
  enhancer.on('error', (d) => broadcast('enhance:error', d))

  ipcMain.on('mic:pcm', (_e, chunk: ArrayBuffer) => {
    recorder.onMicChunk(Buffer.from(chunk))
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
      const { getMainWindow, showMainWindow } = await import('./index')
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
