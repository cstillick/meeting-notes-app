import { create } from 'zustand'
import type { Channel, LiveSegment, RecorderState } from '@shared/types'
import { startMicCapture, type MicCapture } from '../audio/micCapture'

export interface Bubble {
  channel: Channel
  text: string
  startMs: number
}

interface ActiveMeetingState {
  recorderState: RecorderState
  recordingMeetingId: string | null
  statusDetail: string | null
  finals: Bubble[]
  interim: Partial<Record<Channel, Bubble>>
  micLevel: number
  startRecording: (meetingId: string) => Promise<string | null>
  stopRecording: () => Promise<void>
  loadFinals: (finals: Bubble[]) => void
  clearTranscript: () => void
}

let micCapture: MicCapture | null = null
let meterTimer: ReturnType<typeof setInterval> | null = null
let listenersAttached = false

export const useActiveMeetingStore = create<ActiveMeetingState>((set, get) => {
  if (!listenersAttached) {
    listenersAttached = true
    window.api.on('transcript:segment', (segment: LiveSegment) => {
      const { finals, interim } = get()
      const bubble: Bubble = {
        channel: segment.channel,
        text: segment.text,
        startMs: segment.startMs
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
        statusDetail: status.detail ?? null
      })
    })
  }

  return {
    recorderState: 'idle',
    recordingMeetingId: null,
    statusDetail: null,
    finals: [],
    interim: {},
    micLevel: 0,

    startRecording: async (meetingId) => {
      try {
        micCapture = await startMicCapture()
      } catch {
        return 'Microphone access denied — allow it in System Settings → Privacy'
      }
      const result = await window.api.invoke('recorder:start', meetingId)
      if (!result.ok) {
        micCapture?.stop()
        micCapture = null
        return result.error ?? 'Failed to start recording'
      }
      meterTimer = setInterval(() => set({ micLevel: micCapture?.getLevel() ?? 0 }), 120)
      return null
    },

    stopRecording: async () => {
      micCapture?.stop()
      micCapture = null
      if (meterTimer) {
        clearInterval(meterTimer)
        meterTimer = null
      }
      set({ micLevel: 0, interim: {} })
      await window.api.invoke('recorder:stop')
    },

    loadFinals: (finals) => set({ finals, interim: {} }),
    clearTranscript: () => set({ finals: [], interim: {} })
  }
})
