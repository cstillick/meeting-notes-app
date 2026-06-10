import { BrowserWindow, ipcMain } from 'electron'
import type { EventMap, InvokeMap } from '@shared/ipc'
import { getSettingsView, updateSettings } from './settings'
import { recorder } from './transcription/recorder'
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

  ipcMain.on('mic:pcm', (_e, chunk: ArrayBuffer) => {
    recorder.onMicChunk(Buffer.from(chunk))
  })

  recorder.on('segment', (segment) => broadcast('transcript:segment', segment))
  recorder.on('status', (status) => broadcast('recorder:status', status))
}
