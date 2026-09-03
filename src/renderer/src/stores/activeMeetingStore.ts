import { create } from 'zustand'
import type {
  AudioSource,
  Channel,
  LiveSegment,
  RecorderState,
  SpeakerIdentity
} from '@shared/types'
import { startMicCapture, type CaptureProfile, type MicCapture } from '../audio/micCapture'

export interface Bubble {
  channel: Channel
  text: string
  startMs: number
  /** Stable speaker index within (meeting, channel); undefined when that
   *  channel was not diarized. Mic and system are separate namespaces. */
  speaker?: number
}

/** One shared identity for "no roster yet", so a note without speakers does not
 *  retrigger the panel's memos with a fresh [] on every render. */
const NO_SPEAKERS: SpeakerIdentity[] = []

/** The mic profile a capture mode implies. 'system' never opens the mic. */
function profileFor(source: AudioSource): CaptureProfile {
  return source === 'both' ? 'call' : source === 'room' ? 'room' : 'room_call'
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
  /** This recording has the mic muted (capture mode 'system'). */
  micMuted: boolean
  /** What the live recording is capturing. */
  audioSource: AudioSource
  /** Something about the capture is degraded but not broken — e.g. the OS
   *  ignored the far-field constraints. Distinct from `degraded`, which means a
   *  source died. */
  captureWarning: string | null
  /** Voices in the note on screen, named or not. */
  speakers: SpeakerIdentity[]
  startRecording: (meetingId: string, source?: AudioSource) => Promise<string | null>
  stopRecording: () => Promise<void>
  loadFinals: (meetingId: string, finals: Bubble[], speakers?: SpeakerIdentity[]) => void
  renameSpeaker: (
    meetingId: string,
    channel: Channel,
    speaker: number | null,
    name: string
  ) => Promise<void>
  setSpeakerIsMe: (meetingId: string, channel: Channel, speaker: number | null) => Promise<void>
  mergeSpeakers: (meetingId: string, fromIdentityId: number, intoId: number) => Promise<void>
  /** Re-read the note's roster from the DB. */
  refreshSpeakers: (meetingId: string) => Promise<void>
  /** Ask Claude to propose names from the transcript. Writes nothing — the
   *  proposals are shown for the user to accept one at a time, because a
   *  confidently wrong name propagates into notes, chat and every export. */
  suggestSpeakers: (
    meetingId: string
  ) => Promise<{ ok: boolean; error?: string; suggestions?: SpeakerSuggestion[] }>
  acceptSuggestion: (
    meetingId: string,
    channel: Channel,
    speaker: number | null,
    name: string
  ) => Promise<void>
}

/** One proposed name, with the transcript phrase that justifies it. */
export interface SpeakerSuggestion {
  channel: Channel
  speaker: number
  name: string
  reason: string
}

/** Refetch the note's roster when a final introduces a (channel, speaker) the
 *  store has not seen. Keyed the same way the panel keys its lookup. */
let refreshRosterIfNewVoice: (
  meetingId: string,
  channel: Channel,
  speaker: number | undefined
) => Promise<void> = async () => {}

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
        // A voice nobody has heard before just spoke. The roster is derived from
        // the transcript, so it only knows about it once the row is committed —
        // refetch, or a lecture offers no way to name the professor until the
        // recording ends. Gated on the key being new, so this is a handful of
        // calls per recording rather than one per segment.
        void refreshRosterIfNewVoice(segment.meetingId, segment.channel, segment.speaker)
      } else {
        set({ interim: { ...interim, [segment.channel]: bubble } })
      }
    })

    window.api.on('recorder:status', (status) => {
      // A stop can originate in main (an agent's stop_recording, quit) —
      // release the renderer's mic capture whoever ended the recording, or
      // the orange mic indicator stays lit with nothing recording.
      if (status.state === 'idle' && micCapture) {
        micCapture.stop()
        micCapture = null
        if (meterTimer) {
          clearInterval(meterTimer)
          meterTimer = null
        }
        set({ micLevel: 0, micMuted: false, captureWarning: null, interim: {} })
      }
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
    audioSource: 'both',
    captureWarning: null,
    speakers: NO_SPEAKERS,

    startRecording: (meetingId, source) => {
      // Single-flight: the mic prompt keeps the button live for seconds, so the
      // Record button, the detect banner and auto-start can all land at once.
      if (startPending) return startPending
      const run = async (): Promise<string | null> => {
        set({ lastError: null })
        const fail = (message: string): string => {
          set({ lastError: message })
          return message
        }
        // The note's own choice wins; otherwise the user's default. Resolved
        // here rather than in main because the microphone is opened HERE, with
        // constraints that depend on the mode — main is told afterwards so both
        // sides agree on what is being captured.
        let resolved: AudioSource = source ?? 'both'
        if (source === undefined) {
          try {
            resolved = (await window.api.invoke('settings:get')).audioSource
          } catch {
            resolved = 'both'
          }
        }
        // 'system' mutes the mic — don't open it at all: no permission prompt,
        // no PCM sent.
        // Keep the capture local until main confirms the start: whoever loses a
        // race must stop the stream it opened rather than orphan a live mic.
        let capture: MicCapture | null = null
        if (resolved !== 'system') {
          try {
            capture = await startMicCapture({ profile: profileFor(resolved) })
          } catch {
            return fail('Microphone access denied — allow it in System Settings → Privacy')
          }
        }
        const result = await window.api.invoke('recorder:start', meetingId, resolved)
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
          micMuted: resolved === 'system',
          audioSource: resolved,
          captureWarning: capture?.warning ?? null,
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
      set({ micLevel: 0, micMuted: false, captureWarning: null, interim: {} })
      await window.api.invoke('recorder:stop')
      // Trailing finals land during the stop; hand the finished transcript to
      // the view so the panel keeps it once recordingMeetingId clears. Only if
      // that note is the one loaded — a different note on screen must not be
      // handed this recording's bubbles.
      if (meetingId && get().viewFinalsId === meetingId) {
        set({ viewFinals: get().finals, viewFinalsId: meetingId })
        // The roster is derived from the transcript, so the voices of the
        // recording that just ended exist only now. Nothing else refetches it —
        // recorder stop broadcasts no library:changed — so without this the note
        // you just recorded shows no roster strip and no way to name anyone.
        try {
          const loaded = await window.api.invoke('meetings:get', meetingId)
          if (loaded && get().viewFinalsId === meetingId) set({ speakers: loaded.speakers })
        } catch {
          // A failed refetch costs the rename UI until the next note open, which
          // is not worth surfacing as an error over a finished recording.
        }
      }
    },

    loadFinals: (meetingId, finals, speakers) =>
      set({ viewFinals: finals, viewFinalsId: meetingId, speakers: speakers ?? NO_SPEAKERS }),

    // All three write through main and adopt the roster it returns, rather than
    // patching local state: a rename can create, merge or delete an identity,
    // and only the DB knows what the note looks like afterwards.
    renameSpeaker: async (meetingId, channel, speaker, name) => {
      // -1 is the undiarized sentinel the roster tables key on, so "Me" and
      // "Them" are nameable exactly like a diarized voice.
      const rows = await window.api.invoke(
        'speakers:setName',
        meetingId,
        channel,
        speaker ?? -1,
        name
      )
      if (get().viewFinalsId === meetingId) set({ speakers: rows })
    },

    setSpeakerIsMe: async (meetingId, channel, speaker) => {
      const rows = await window.api.invoke('speakers:setMe', meetingId, channel, speaker ?? -1)
      if (get().viewFinalsId === meetingId) set({ speakers: rows })
    },

    mergeSpeakers: async (meetingId, fromIdentityId, intoId) => {
      const rows = await window.api.invoke('speakers:merge', meetingId, fromIdentityId, intoId)
      if (get().viewFinalsId === meetingId) set({ speakers: rows })
    },

    suggestSpeakers: (meetingId) => window.api.invoke('speakers:suggest', meetingId),

    refreshSpeakers: async (meetingId) => {
      const loaded = await window.api.invoke('meetings:get', meetingId)
      if (loaded && get().viewFinalsId === meetingId) set({ speakers: loaded.speakers })
    },

    acceptSuggestion: async (meetingId, channel, speaker, name) => {
      const rows = await window.api.invoke(
        'speakers:accept',
        meetingId,
        channel,
        speaker ?? -1,
        name
      )
      if (get().viewFinalsId === meetingId) set({ speakers: rows })
    }
  }
})

// Bound after the store exists, because the segment listener above is installed
// during the store's own construction and cannot reference it yet. In flight at
// most once per unseen voice: a repeat key returns before touching IPC.
const seenVoices = new Set<string>()
refreshRosterIfNewVoice = async (meetingId, channel, speaker) => {
  const state = useActiveMeetingStore.getState()
  if (state.viewFinalsId !== meetingId) return
  const key = `${meetingId}:${channel}:${speaker ?? -1}`
  if (seenVoices.has(key)) return
  if (state.speakers.some((s) => s.channel === channel && (s.speaker ?? -1) === (speaker ?? -1))) {
    seenVoices.add(key)
    return
  }
  seenVoices.add(key)
  try {
    await useActiveMeetingStore.getState().refreshSpeakers(meetingId)
  } catch {
    // The roster reappears on the next new voice, on stop, or on note reload.
    seenVoices.delete(key)
  }
}
