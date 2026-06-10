import type {
  LiveSegment,
  Meeting,
  MeetingSummary,
  RecorderStatus,
  SettingsUpdate,
  SettingsView,
  TranscriptSegment
} from './types'

/** Renderer → main request/response (ipcRenderer.invoke). */
export interface InvokeMap {
  'meetings:create': () => Meeting
  'meetings:list': () => MeetingSummary[]
  'meetings:get': (id: string) => { meeting: Meeting; segments: TranscriptSegment[] } | null
  'meetings:updateTitle': (id: string, title: string) => void
  'meetings:delete': (id: string) => void
  'notes:save': (id: string, notesJson: string) => void
  'recorder:start': (meetingId: string) => { ok: boolean; error?: string }
  'recorder:stop': () => void
  'enhance:start': (meetingId: string) => { ok: boolean; error?: string }
  'enhance:cancel': () => void
  'enhance:saveResult': (
    id: string,
    enhancedJson: string,
    enhancedMd: string,
    title?: string
  ) => void
  'search:query': (q: string) => MeetingSummary[]
  'settings:get': () => SettingsView
  'settings:set': (update: SettingsUpdate) => SettingsView
}

/** Renderer → main fire-and-forget (ipcRenderer.send). High-frequency channels. */
export interface SendMap {
  /** 16 kHz s16le mono PCM chunks (~50 ms) from the renderer mic capture. */
  'mic:pcm': (chunk: ArrayBuffer) => void
}

/** Main → renderer events (webContents.send). */
export interface EventMap {
  'transcript:segment': (segment: LiveSegment) => void
  'recorder:status': (status: RecorderStatus) => void
  'mic:activity': (activity: { inUse: boolean }) => void
  'enhance:delta': (delta: { meetingId: string; text: string }) => void
  'enhance:done': (result: { meetingId: string; markdown: string }) => void
  'enhance:error': (err: { meetingId: string; message: string }) => void
}

export type InvokeChannel = keyof InvokeMap
export type SendChannel = keyof SendMap
export type EventChannel = keyof EventMap
