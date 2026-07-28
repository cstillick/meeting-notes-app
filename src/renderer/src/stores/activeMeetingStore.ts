import { create } from 'zustand'
import type { Channel, LiveSegment, RecorderState } from '@shared/types'
import { startMicCapture, type MicCapture } from '../audio/micCapture'

export interface Bubble {
  channel: Channel
  text: string
  startMs: number
  /** Diarized speaker index (system channel); undefined = unknown ("Them"). */
  speaker?: number
}

interface ActiveMeetingState {
  recorderState: RecorderState
  recordingMeetingId: string | null
  statusDetail: string | null
  /** Capture sources that died mid-recording; empty while everything is healthy.
   *  A non-empty list means statusDetail is a persistent failure, not progress. */
  degraded: Channel[]
  /** Last failed start — shown in the UI even when the start came from the
   *  detect panel / auto-start flow, which has no button to report through. */
  lastError: string | null
  /** Live finals of `recordingMeetingId`. Segments stamped with any other
   *  meeting are dropped, so a note on screen never collects another's speech. */
  finals: Bubble[]
  /** Stored transcript of the note being viewed, and the note it belongs to. */
  viewFinals: Bubble[]
  viewFinalsId: string | null
  interim: Partial<Record<Channel, Bubble>>
  micLevel: number
  /** This recording has the mic muted (the "system audio only" setting). */
  micMuted: boolean
  startRecording: (meetingId: string) => Promise<string | null>
  stopRecording: () => Promise<void>
  loadFinals: (meetingId: string, finals: Bubble[]) => void
}

let micCapture: MicCapture | null = null
let meterTimer: ReturnType<typeof setInterval> | null = null
let startPending: Promise<string | null> | null = null
let listenersAttached = false

export const useActiveMeetingStore = create<ActiveMeetingState>((set, get) => {
  if (!listenersAttached) {
    listenersAttached = true
    window.api.on('transcript:segment', (segment: LiveSegment) => {
      const { finals, interim, recordingMeetingId } = get()
      if (segment.meetingId !== recordingMeetingId) return
      if (segment.suppressed) {
        // Echo retraction: the text was remote audio leaking into the mic.
        // Clear any live bubble showing it; never append to finals.
        set({ interim: { ...interim, [segment.channel]: undefined } })
        return
      }
      const bubble: Bubble = {
        channel: segment.channel,
        text: segment.text,
        startMs: segment.startMs,
        speaker: segment.speaker
      }
      if (segment.isFinal) {
        set({
          finals: [...finals, bubble].sort((a, b) => a.startMs - b.startMs),
          interim: { ...interim, [segment.channel]: undefined }
        })
      } else {
        set({ interim: { ...interim, [segment.channel]: bubble } })
      }
    })

    window.api.on('recorder:status', (status) => {
      set({
        recorderState: status.state,
        recordingMeetingId: status.meetingId,
        statusDetail: status.detail ?? null,
        degraded: status.degraded ?? []
      })
    })
  }

  return {
    recorderState: 'idle',
    recordingMeetingId: null,
    statusDetail: null,
    degraded: [],
    lastError: null,
    finals: [],
    viewFinals: [],
    viewFinalsId: null,
    interim: {},
    micLevel: 0,
    micMuted: false,

    startRecording: (meetingId) => {
      // Single-flight: the mic prompt keeps the button live for seconds, so the
      // Record button, the detect banner and auto-start can all land at once.
      if (startPending) return startPending
      const run = async (): Promise<string | null> => {
        set({ lastError: null })
        const fail = (message: string): string => {
          set({ lastError: message })
          return message
        }
        // "System audio only" mutes the mic — don't open it at all (no permission
        // prompt, no PCM sent). On any read failure, fall back to capturing.
        let systemAudioOnly = false
        try {
          systemAudioOnly = (await window.api.invoke('settings:get')).systemAudioOnly
        } catch {
          systemAudioOnly = false
        }
        // Keep the capture local until main confirms the start: whoever loses a
        // race must stop the stream it opened rather than orphan a live mic.
        let capture: MicCapture | null = null
        if (!systemAudioOnly) {
          try {
            capture = await startMicCapture()
          } catch {
            return fail('Microphone access denied — allow it in System Settings → Privacy')
          }
        }
        const result = await window.api.invoke('recorder:start', meetingId)
        if (!result.ok) {
          capture?.stop()
          return fail(result.error ?? 'Failed to start recording')
        }
        micCapture?.stop()
        micCapture = capture
        if (meterTimer) {
          clearInterval(meterTimer)
          meterTimer = null
        }
        if (capture) {
          meterTimer = setInterval(() => set({ micLevel: capture?.getLevel() ?? 0 }), 120)
        }
        const { viewFinals, viewFinalsId } = get()
        set({
          micMuted: systemAudioOnly,
          micLevel: 0,
          // Recording this note again keeps its stored bubbles on screen; any
          // other note starts clean so the last recording's finals don't leak in.
          finals: viewFinalsId === meetingId ? viewFinals : [],
          interim: {}
        })
        return null
      }
      startPending = run()
      void startPending.finally(() => {
        startPending = null
      })
      return startPending
    },

    stopRecording: async () => {
      const meetingId = get().recordingMeetingId
      micCapture?.stop()
      micCapture = null
      if (meterTimer) {
        clearInterval(meterTimer)
        meterTimer = null
      }
      set({ micLevel: 0, micMuted: false, interim: {} })
      await window.api.invoke('recorder:stop')
      // Trailing finals land during the stop; hand the finished transcript to
      // the view so the panel keeps it once recordingMeetingId clears. Only if
      // that note is the one loaded — a different note on screen must not be
      // handed this recording's bubbles.
      if (meetingId && get().viewFinalsId === meetingId) {
        set({ viewFinals: get().finals, viewFinalsId: meetingId })
      }
    },

    loadFinals: (meetingId, finals) => set({ viewFinals: finals, viewFinalsId: meetingId })
  }
})
