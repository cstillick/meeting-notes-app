import type {
  ChatMessage,
  ChatSendRequest,
  Folder,
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
  /** Move a note into a folder, or null to unfile it. */
  'meetings:setFolder': (id: string, folderId: string | null) => void
  'notes:save': (id: string, notesJson: string) => void
  'folders:list': () => Folder[]
  'folders:create': (name: string) => Folder
  'folders:rename': (id: string, name: string) => void
  /** Delete a folder. Its notes are unfiled (kept), not deleted. */
  'folders:delete': (id: string) => void
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
  /** Persist a manual edit to the enhanced doc (no re-enhance / re-title). */
  'enhanced:save': (id: string, enhancedJson: string) => void
  'search:query': (q: string) => MeetingSummary[]
  /** Buttons on the floating "meeting detected" panel. */
  'detect:action': (action: 'start' | 'dismiss') => void
  /** True once if a detect-panel start is waiting for a freshly created window.
   *  The renderer asks on mount; events sent before React attaches listeners
   *  would otherwise be lost. */
  'detect:consumePending': () => boolean
  'settings:get': () => SettingsView
  'settings:set': (update: SettingsUpdate) => SettingsView
  /** Ask the floating chat. meetingId null = global (cross-meeting) thread. */
  'chat:send': (req: ChatSendRequest) => Promise<{ ok: boolean; error?: string }>
  'chat:history': (meetingId: string | null, folderId: string | null) => ChatMessage[]
  'chat:cancel': (chatKey: string) => void
  'chat:clear': (meetingId: string | null, folderId: string | null) => void
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
  /** User clicked the "meeting detected" system notification: create a meeting and record. */
  'meeting:autoStart': () => void
  'enhance:delta': (delta: { meetingId: string; text: string }) => void
  'enhance:done': (result: { meetingId: string; markdown: string }) => void
  'enhance:error': (err: { meetingId: string; message: string }) => void
  /** chatKey = meetingId, or 'global' for the cross-meeting thread. */
  'chat:delta': (delta: { chatKey: string; text: string }) => void
  'chat:done': (result: { chatKey: string; markdown: string; message: ChatMessage }) => void
  'chat:error': (err: { chatKey: string; message: string }) => void
}

export type InvokeChannel = keyof InvokeMap
export type SendChannel = keyof SendMap
export type EventChannel = keyof EventMap
