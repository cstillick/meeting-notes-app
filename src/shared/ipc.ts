import type {
  AudioSource,
  Channel,
  ChatMessage,
  ChatSendRequest,
  Folder,
  GraphData,
  ImportStatus,
  LiveSegment,
  Meeting,
  MeetingSummary,
  RecorderStatus,
  RelatedNote,
  SettingsUpdate,
  SettingsView,
  SpeakerIdentity,
  TranscriptSegment
} from './types'

/** Renderer → main request/response (ipcRenderer.invoke). */
export interface InvokeMap {
  'meetings:create': () => Meeting
  'meetings:list': () => MeetingSummary[]
  'meetings:get': (
    id: string
  ) => {
    meeting: Meeting
    segments: TranscriptSegment[]
    /** Every distinct voice in the transcript, named or not. */
    speakers: SpeakerIdentity[]
  } | null
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
  /** `source` is the note's own capture choice; omitted falls back to the
   *  user's default. It cannot be changed once recording has started. */
  'recorder:start': (
    meetingId: string,
    source?: AudioSource
  ) => { ok: boolean; error?: string }
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
  /** Name one voice. Applies retroactively to every line already stored and
   *  every line still to arrive — names live on the roster, never on a segment.
   *  All four return the note's refreshed roster. */
  'speakers:setName': (
    meetingId: string,
    channel: Channel,
    speaker: number,
    name: string
  ) => SpeakerIdentity[]
  /** Forget a name; the voice falls back to its generated label. */
  'speakers:clear': (meetingId: string, channel: Channel, speaker: number) => SpeakerIdentity[]
  /** Mark a voice as the note-taker. At most one per note. */
  'speakers:setMe': (meetingId: string, channel: Channel, speaker: number) => SpeakerIdentity[]
  /** "These two voices are one person" — the fix for a diarizer split, or for
   *  the fresh numbering a reconnect hands the same human. */
  'speakers:merge': (
    meetingId: string,
    fromIdentityId: number,
    intoIdentityId: number
  ) => SpeakerIdentity[]
  /** Accept one proposal from speakers:suggest. Separate from setName so the
   *  roster can show that a name came from the model and has not been vetted. */
  'speakers:accept': (
    meetingId: string,
    channel: Channel,
    speaker: number,
    name: string
  ) => SpeakerIdentity[]
  /** Ask Claude to propose names from the transcript's own self-introductions.
   *  Returns proposals and writes nothing; accepting one calls speakers:accept. */
  'speakers:suggest': (meetingId: string) => {
    ok: boolean
    error?: string
    suggestions?: { channel: Channel; speaker: number; name: string; reason: string }[]
  }
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
  /** Renderer ack that every pending editor save has been written — main holds
   *  quit (bounded by a timeout) for this after sending app:will-quit. */
  'app:flushed': () => void
  /** Open a file picker and start transcribing the chosen recordings. Each
   *  becomes a new note immediately; progress arrives as import:status events.
   *  null = the user cancelled the picker. */
  'import:pick': () => { started: { noteId: string; file: string }[]; errors: string[] } | null
  /** Note id of a recording-start request that arrived while no window was
   *  loaded (calendar auto-record, an agent's start_recording). The renderer
   *  asks on mount; events sent before React attaches listeners are lost. */
  'recording:consumePendingStart': () => string | null
  /** Export one note to a file; main shows the save dialog. null = cancelled. */
  'export:note': (
    noteId: string,
    format: 'md' | 'html' | 'pdf' | 'docx'
  ) => { ok: boolean; path?: string; error?: string } | null
  /** Export the library or one folder as an Obsidian vault (directory) or a
   *  JSON bundle (file); main shows the picker. null = cancelled. */
  'export:library': (
    folderId: string | null,
    kind: 'obsidian' | 'json'
  ) => { ok: boolean; path?: string; files?: number; error?: string } | null
  /** Export a note, a folder, or the whole library to Notion. */
  'export:notion': (target: { noteId?: string; folderId?: string | null }) => {
    ok: boolean
    url?: string
    pages?: number
    error?: string
  }
  /** The knowledge graph: notes + extracted entities, weighted links.
   *  null folder = the whole library. */
  'graph:get': (folderId: string | null) => GraphData
  /** Notes tied to this one through shared entities, strongest first. */
  'graph:related': (meetingId: string) => RelatedNote[]
  /** Clear every extraction stamp and re-extract the whole library. */
  'graph:rebuild': () => void
}

/** Renderer → main fire-and-forget (ipcRenderer.send). High-frequency channels. */
export interface SendMap {
  /** 16 kHz s16le mono PCM chunks (~50 ms) from the renderer mic capture. */
  'mic:pcm': (chunk: ArrayBuffer) => void
  /** Uncaught renderer faults, persisted to the main-process diagnostic log —
   *  a white screen mid-recording otherwise leaves no trace anywhere. */
  'log:error': (line: string) => void
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
  /** `retryable`: transport-level failure (429/5xx) rather than a refusal or a
   *  bad request — the renderer may offer an automatic retry only for those.
   *  `partial`: whatever markdown streamed before the failure, so the user can
   *  keep it; absent when nothing streamed. Both are emitted by the enhancer
   *  today; declaring them here is what type-checks the emit sites. */
  'enhance:error': (err: {
    meetingId: string
    message: string
    retryable: boolean
    partial?: string
  }) => void
  /** chatKey = meetingId, or 'global' for the cross-meeting thread. */
  'chat:delta': (delta: { chatKey: string; text: string }) => void
  'chat:done': (result: { chatKey: string; markdown: string; message: ChatMessage }) => void
  'chat:error': (err: { chatKey: string; message: string; retryable: boolean }) => void
  /** Quit is imminent: flush pending editor saves, then invoke app:flushed. */
  'app:will-quit': () => void
  /** An out-of-process agent (MCP) changed the library: refresh lists, and
   *  views showing one of the named notes should reload it. */
  'library:changed': (change: { noteIds: string[]; folders: boolean }) => void
  /** File-import transcription progress for one note. */
  'import:status': (status: ImportStatus) => void
  /** Start recording this specific (already-created, already-titled) note —
   *  calendar auto-record or an agent's start_recording. The renderer owns the
   *  start because the microphone is captured in the renderer. */
  'recording:startRequested': (req: { noteId: string }) => void
  /** Entity extraction finished a pass — an open graph view should refetch. */
  'graph:changed': () => void
}

export type InvokeChannel = keyof InvokeMap
export type SendChannel = keyof SendMap
export type EventChannel = keyof EventMap

// Runtime allowlists for the preload bridge. The maps above are types, erased
// at build time, so nothing stops a script in a renderer from reaching a
// channel it was never meant to see. Declared as exhaustive records so a
// channel added to a map without an entry here fails to compile.
const invokeChannels: Record<InvokeChannel, true> = {
  'meetings:create': true,
  'meetings:list': true,
  'meetings:get': true,
  'meetings:updateTitle': true,
  'meetings:delete': true,
  'meetings:setFolder': true,
  'notes:save': true,
  'folders:list': true,
  'folders:create': true,
  'folders:rename': true,
  'folders:delete': true,
  'recorder:start': true,
  'recorder:stop': true,
  'enhance:start': true,
  'enhance:cancel': true,
  'enhance:saveResult': true,
  'enhanced:save': true,
  'search:query': true,
  'speakers:setName': true,
  'speakers:clear': true,
  'speakers:setMe': true,
  'speakers:merge': true,
  'speakers:accept': true,
  'speakers:suggest': true,
  'detect:action': true,
  'detect:consumePending': true,
  'settings:get': true,
  'settings:set': true,
  'chat:send': true,
  'chat:history': true,
  'chat:cancel': true,
  'chat:clear': true,
  'app:flushed': true,
  'import:pick': true,
  'recording:consumePendingStart': true,
  'graph:get': true,
  'graph:related': true,
  'graph:rebuild': true,
  'export:note': true,
  'export:library': true,
  'export:notion': true
}

const sendChannels: Record<SendChannel, true> = {
  'mic:pcm': true,
  'log:error': true
}

const eventChannels: Record<EventChannel, true> = {
  'transcript:segment': true,
  'recorder:status': true,
  'mic:activity': true,
  'meeting:autoStart': true,
  'enhance:delta': true,
  'enhance:done': true,
  'enhance:error': true,
  'chat:delta': true,
  'chat:done': true,
  'chat:error': true,
  'app:will-quit': true,
  'library:changed': true,
  'import:status': true,
  'recording:startRequested': true,
  'graph:changed': true
}

export const INVOKE_CHANNELS = Object.keys(invokeChannels) as readonly InvokeChannel[]
export const SEND_CHANNELS = Object.keys(sendChannels) as readonly SendChannel[]
export const EVENT_CHANNELS = Object.keys(eventChannels) as readonly EventChannel[]
