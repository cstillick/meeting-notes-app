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
}

/** Live segment streamed to the renderer; interim segments replace the open bubble. */
export interface LiveSegment {
  channel: Channel
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
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
