import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveMeetingStore } from '../stores/activeMeetingStore'

export default function MeetingDetectedBanner(): React.JSX.Element | null {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const { recorderState, startRecording } = useActiveMeetingStore()

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

  async function takeNotes(): Promise<void> {
    setVisible(false)
    const meeting = await window.api.invoke('meetings:create')
    navigate(`/note/${meeting.id}`)
    await startRecording(meeting.id)
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
