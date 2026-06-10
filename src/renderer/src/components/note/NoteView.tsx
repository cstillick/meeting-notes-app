import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Meeting } from '@shared/types'
import { useActiveMeetingStore } from '../../stores/activeMeetingStore'
import NoteEditor from './NoteEditor'
import TranscriptPanel from './TranscriptPanel'

function RecordButton({ meetingId }: { meetingId: string }): React.JSX.Element {
  const { recorderState, recordingMeetingId, micLevel, startRecording, stopRecording } =
    useActiveMeetingStore()
  const [error, setError] = useState<string | null>(null)

  const isThisMeeting = recordingMeetingId === meetingId
  const recording = isThisMeeting && (recorderState === 'recording' || recorderState === 'starting')
  const busy = recorderState === 'starting' || recorderState === 'stopping'
  const blocked = !isThisMeeting && recordingMeetingId !== null && recorderState !== 'idle'

  async function toggle(): Promise<void> {
    setError(null)
    if (recording) {
      await stopRecording()
    } else {
      const err = await startRecording(meetingId)
      if (err) setError(err)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="max-w-xs truncate text-xs text-red-600">{error}</span>}
      {recording && (
        <div className="flex h-4 items-end gap-0.5" title="Mic level">
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <div
              key={t}
              className={`w-1 rounded-sm transition-all ${
                micLevel >= t * 0.6 ? 'bg-green-500' : 'bg-stone-300'
              }`}
              style={{ height: `${t * 100}%` }}
            />
          ))}
        </div>
      )}
      <button
        onClick={toggle}
        disabled={busy || blocked}
        title={blocked ? 'Another meeting is recording' : undefined}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm disabled:opacity-50 ${
          recording
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-stone-800 text-white hover:bg-stone-900'
        }`}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            recording ? 'animate-pulse bg-white' : 'bg-red-500'
          }`}
        />
        {recorderState === 'starting' && isThisMeeting
          ? 'Starting…'
          : recorderState === 'stopping' && isThisMeeting
            ? 'Stopping…'
            : recording
              ? 'Stop'
              : 'Record'}
      </button>
    </div>
  )
}

export default function NoteView(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [title, setTitle] = useState('')
  const [showTranscript, setShowTranscript] = useState(true)
  const { finals, interim, loadFinals, clearTranscript, recordingMeetingId, statusDetail } =
    useActiveMeetingStore()

  useEffect(() => {
    if (!id) return
    void window.api.invoke('meetings:get', id).then((result) => {
      if (!result) return
      setMeeting(result.meeting)
      setTitle(result.meeting.title)
      // If we're not actively recording this meeting, show its stored transcript
      if (useActiveMeetingStore.getState().recordingMeetingId !== id) {
        clearTranscript()
        loadFinals(
          result.segments.map((s) => ({ channel: s.channel, text: s.text, startMs: s.startMs }))
        )
      }
    })
  }, [id, loadFinals, clearTranscript])

  const saveTitle = useCallback(
    (value: string) => {
      if (id && value !== meeting?.title) {
        void window.api.invoke('meetings:updateTitle', id, value)
      }
    },
    [id, meeting?.title]
  )

  if (!id) return <div />

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center gap-3 border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-700">
          ←
        </Link>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => saveTitle(e.target.value)}
          placeholder="Untitled meeting"
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-stone-800 placeholder-stone-400 focus:outline-none"
        />
        <button
          onClick={() => setShowTranscript((v) => !v)}
          className={`rounded-md px-2.5 py-1.5 text-sm ${
            showTranscript ? 'bg-stone-200 text-stone-700' : 'text-stone-500 hover:bg-stone-200/70'
          }`}
        >
          Transcript
        </button>
        <RecordButton meetingId={id} />
      </header>

      {statusDetail && recordingMeetingId === id && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-1 text-xs text-amber-800">
          {statusDetail}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {meeting && <NoteEditor meetingId={id} initialContent={meeting.notesJson} />}
        </main>
        {showTranscript && (
          <aside className="w-80 shrink-0 border-l border-stone-200 bg-stone-100/60">
            <TranscriptPanel finals={finals} interim={interim} />
          </aside>
        )}
      </div>
    </div>
  )
}
