export type MeetingStatus = 'draft' | 'recording' | 'recorded' | 'enhancing' | 'enhanced'

export interface Meeting {
  id: string
  title: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  status: MeetingStatus
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
}

/** What the renderer is allowed to know about settings — never the key material. */
export interface SettingsView {
  deepgramKeySet: boolean
  anthropicKeySet: boolean
  model: string
}

export interface SettingsUpdate {
  deepgramKey?: string
  anthropicKey?: string
  model?: string
}

export const DEFAULT_MODEL = 'claude-opus-4-8'

/** Claude models the user can pick in Settings. id is the exact API model string. */
export interface ModelOption {
  id: string
  label: string
  hint: string
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', hint: 'Most capable — slowest, priciest' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'Most capable Opus (default)' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: 'Previous-gen Opus' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Balanced speed and quality' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Fastest and cheapest' }
]

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
  question: string
  liveFinals?: ChatLiveFinal[]
}
