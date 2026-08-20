import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveMeetingStore } from '../stores/activeMeetingStore'

export default function MeetingDetectedBanner(): React.JSX.Element | null {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const recorderState = useActiveMeetingStore((s) => s.recorderState)
  const startRecording = useActiveMeetingStore((s) => s.startRecording)
  // The button, the notification and the parked panel request can all fire
  // before recorderState leaves 'idle' — one meeting, one start.
  const starting = useRef(false)

  useEffect(() => {
    return window.api.on('mic:activity', ({ inUse }) => {
      if (!inUse) {
        setVisible(false)
        setDismissed(false)
      } else {
        setVisible(true)
      }
    })
  }, [])

  // System notification clicked: same flow as the banner's Start button.
  useEffect(() => {
    return window.api.on('meeting:autoStart', () => {
      if (useActiveMeetingStore.getState().recorderState !== 'idle') return
      void takeNotes()
    })
  }, [])

  // Panel clicked while the window was closed: the start request is parked in
  // the main process (events sent before mount are lost) — pick it up now.
  useEffect(() => {
    void window.api.invoke('detect:consumePending').then((pending) => {
      if (pending && useActiveMeetingStore.getState().recorderState === 'idle') {
        void takeNotes()
      }
    })
  }, [])

  // Calendar auto-record or an agent's start_recording: main already created
  // and titled the note; the renderer owns the actual start (mic capture).
  useEffect(() => {
    return window.api.on('recording:startRequested', ({ noteId }) => {
      void startForNote(noteId)
    })
  }, [])

  useEffect(() => {
    void window.api.invoke('recording:consumePendingStart').then((noteId) => {
      if (noteId) void startForNote(noteId)
    })
  }, [])

  async function startForNote(noteId: string): Promise<void> {
    if (starting.current) return
    if (useActiveMeetingStore.getState().recorderState !== 'idle') return
    starting.current = true
    setVisible(false)
    try {
      navigate(`/note/${noteId}`)
      await startRecording(noteId)
    } finally {
      starting.current = false
    }
  }

  async function takeNotes(): Promise<void> {
    if (starting.current) return
    starting.current = true
    setVisible(false)
    try {
      const meeting = await window.api.invoke('meetings:create')
      navigate(`/note/${meeting.id}`)
      await startRecording(meeting.id)
    } finally {
      starting.current = false
    }
  }

  // Hide while we're the ones using the mic
  if (!visible || dismissed || recorderState !== 'idle') return null

  return (
    <div className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-lg">
      <span className="text-sm text-stone-700">
        Looks like a meeting started — take notes?
      </span>
      <button
        onClick={() => void takeNotes()}
        className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
      >
        Start
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="rounded-md px-2 py-1.5 text-sm text-stone-400 hover:text-stone-600"
      >
        Dismiss
      </button>
    </div>
  )
}
