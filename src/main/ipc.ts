import { BrowserWindow, ipcMain } from 'electron'
import type { EventMap, InvokeMap } from '@shared/ipc'
import { getSettingsView, updateSettings } from './settings'
import { recorder } from './transcription/recorder'
import { enhancer } from './enhance/enhancer'
import { MicMonitor } from './audio/micMonitor'

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
  // suppress while our own capture holds the mic open.
  micMonitor = new MicMonitor()
  let debounce: NodeJS.Timeout | null = null
  micMonitor.on('activity', (inUse) => {
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    if (inUse) {
      debounce = setTimeout(() => {
        if (!recorder.recording) broadcast('mic:activity', { inUse: true })
      }, 3000)
    } else {
      broadcast('mic:activity', { inUse: false })
    }
  })
  micMonitor.start()
}
