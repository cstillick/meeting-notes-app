export type MeetingStatus = 'draft' | 'recording' | 'recorded' | 'enhancing' | 'enhanced'

export interface Meeting {
  id: string
  title: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  status: MeetingStatus
  /** Folder this note lives in; null = unfiled (shown under "All notes"). */
  folderId: string | null
  notesJson: string
  enhancedJson: string | null
  enhancedMd: string | null
  enhancedAt: number | null
}

export interface MeetingSummary {
  id: string
  title: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  status: MeetingStatus
  folderId: string | null
}

/** A named collection of notes. Chat asked from inside a folder only sees its notes. */
export interface Folder {
  id: string
  name: string
  createdAt: number
}

export type Channel = 'mic' | 'system'

export interface TranscriptSegment {
  id: number
  meetingId: string
  channel: Channel
  text: string
  startMs: number
  endMs: number
  /** Diarized speaker index on the system channel; null for mic and legacy rows. */
  speaker: number | null
}

/** Live segment streamed to the renderer; interim segments replace the open bubble. */
export interface LiveSegment {
  /** Meeting this segment belongs to — the broadcast reaches every window, so
   *  a viewer showing a different note must drop it. */
  meetingId: string
  channel: Channel
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  speaker?: number
  /** Echo suppression retracted this segment — clear any open bubble for the channel. */
  suppressed?: boolean
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

export interface RecorderStatus {
  state: RecorderState
  meetingId: string | null
  detail?: string
  /** Capture sources that died mid-recording. The state stays 'recording' so
   *  the user can still stop and keep what was captured; detail says what broke. */
  degraded?: Channel[]
}

/** What the renderer is allowed to know about settings — never the key material. */
export interface SettingsView {
  deepgramKeySet: boolean
  anthropicKeySet: boolean
  /** Voyage AI key — optional; enables semantic (vector) retrieval for cross-note chat. */
  voyageKeySet: boolean
  model: string
  /** Mute the mic: record only system audio (what the other participants say). */
  systemAudioOnly: boolean
}

export interface SettingsUpdate {
  deepgramKey?: string
  anthropicKey?: string
  voyageKey?: string
  model?: string
  systemAudioOnly?: boolean
}

export const DEFAULT_MODEL = 'claude-opus-5'

/** Claude models the user can pick in Settings. id is the exact API model
 *  string. The capabilities are load-bearing, not documentation: the wrong
 *  thinking config or an oversized prompt is a 400 from the API, not a
 *  degraded answer. */
export interface ModelOption {
  id: string
  label: string
  hint: string
  /** 4.6 and newer accept `thinking: {type:'adaptive'}`; older models only take
   *  `{type:'enabled', budget_tokens}` and reject adaptive outright, so they get
   *  no thinking block at all. */
  adaptiveThinking: boolean
  /** Context window. Haiku 4.5 is 200K; every other offered model is 1M. */
  contextTokens: number
}

const M = 1_000_000

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    hint: 'Most capable — slowest, priciest',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    hint: 'Most capable Opus (default)',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    hint: 'Previous-gen Opus',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    hint: 'Older Opus',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    hint: 'Near-Opus quality, faster and cheaper',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    hint: 'Balanced speed and quality',
    adaptiveThinking: true,
    contextTokens: M
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    hint: 'Fastest and cheapest — 200K context, no extended thinking',
    adaptiveThinking: false,
    contextTokens: 200_000
  }
]

/** Capabilities for any model string, including one hand-edited into
 *  settings.json or left behind by an older build (Settings renders those as
 *  "(custom)", so they are a supported state). Unknown ids get the conservative
 *  shape: no thinking block, and the smallest window we know of. */
export function modelCapabilities(id: string): ModelOption {
  return (
    AVAILABLE_MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      hint: '',
      adaptiveThinking: false,
      contextTokens: 200_000
    }
  )
}

/** The `thinking` field a request may carry for this model, spread into the
 *  params object. Older models reject `adaptive` outright and want an explicit
 *  `{type:'enabled', budget_tokens}` instead, so they get no thinking block at
 *  all — one helper so the chat and enhance paths can never disagree. */
export function thinkingParams(model: ModelOption): { thinking?: { type: 'adaptive' } } {
  return model.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}
}

/** Statuses the API asks clients to retry: 429 (rate limited, carries
 *  retry-after) and 5xx (529 = overloaded). Everything else — 400, 401, 403 —
 *  fails the same way on every attempt. */
export function isRetryableApiStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500)
}

/** One persisted chat turn. meetingId null = the global (cross-meeting) thread. */
export interface ChatMessage {
  id: number
  meetingId: string | null
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

/** Final transcript bubble passed from the renderer with a live-meeting chat
 *  question — fresher than the DB, which holds mic finals ~3.5s for echo checks. */
export interface ChatLiveFinal {
  channel: Channel
  text: string
  startMs: number
  speaker?: number
}

export interface ChatSendRequest {
  meetingId: string | null
  /** When meetingId is null, scopes the cross-note thread to one folder's
   *  notes. null/undefined = the global thread spanning every note. */
  folderId?: string | null
  question: string
  liveFinals?: ChatLiveFinal[]
}

/** Identifies a chat thread. A note's id scopes to that note; otherwise a
 *  folder id scopes to that folder; otherwise the one global thread. Shared by
 *  the renderer (store keys, panels) and main (stream routing) so they agree. */
export function chatKeyFor(meetingId: string | null, folderId?: string | null): string {
  if (meetingId) return meetingId
  if (folderId) return `folder:${folderId}`
  return 'global'
}
