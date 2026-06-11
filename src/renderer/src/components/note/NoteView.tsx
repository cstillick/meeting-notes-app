import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Meeting } from '@shared/types'
import { useActiveMeetingStore } from '../../stores/activeMeetingStore'
import { useEnhanceStore } from '../../stores/enhanceStore'
import NoteEditor from './NoteEditor'
import TranscriptPanel from './TranscriptPanel'
import { EnhancedDoc, StreamingPreview } from './EnhancedView'

function RecordButton({ meetingId }: { meetingId: string }): React.JSX.Element {
  const { recorderState, recordingMeetingId, micLevel, lastError, startRecording, stopRecording } =
    useActiveMeetingStore()

  const isThisMeeting = recordingMeetingId === meetingId
  const recording = isThisMeeting && (recorderState === 'recording' || recorderState === 'starting')
  const busy = recorderState === 'starting' || recorderState === 'stopping'
  const blocked = !isThisMeeting && recordingMeetingId !== null && recorderState !== 'idle'

  async function toggle(): Promise<void> {
    if (recording) {
      await stopRecording()
    } else {
      await startRecording(meetingId)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {lastError && (
        <span className="max-w-xs truncate text-xs text-red-600" title={lastError}>
          {lastError}
        </span>
      )}
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
  const [tab, setTab] = useState<'notes' | 'enhanced'>('notes')
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const { finals, interim, loadFinals, clearTranscript, recordingMeetingId, statusDetail } =
    useActiveMeetingStore()
  const enhance = useEnhanceStore()

  const reload = useCallback(() => {
    if (!id) return
    void window.api.invoke('meetings:get', id).then((result) => {
      if (!result) return
      setMeeting(result.meeting)
      setTitle(result.meeting.title)
      // If we're not actively recording this meeting, show its stored transcript
      if (useActiveMeetingStore.getState().recordingMeetingId !== id) {
        clearTranscript()
        loadFinals(
          result.segments.map((s) => ({
            channel: s.channel,
            text: s.text,
            startMs: s.startMs,
            speaker: s.speaker ?? undefined
          }))
        )
      }
    })
  }, [id, loadFinals, clearTranscript])

  useEffect(() => reload(), [reload])

  // Reload when an enhancement result lands (updates doc + maybe auto-title)
  useEffect(() => {
    if (enhance.savedVersion > 0) {
      reload()
      setTab('enhanced')
    }
  }, [enhance.savedVersion, reload])

  const isStreamingThis = enhance.streamingId === id

  async function onEnhance(): Promise<void> {
    if (!id) return
    setEnhanceError(null)
    setTab('enhanced')
    const err = await enhance.start(id)
    if (err) setEnhanceError(err)
  }

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
        {isStreamingThis ? (
          <button
            onClick={() => enhance.cancel()}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onEnhance}
            disabled={recordingMeetingId === id || finals.length === 0}
            title={
              finals.length === 0
                ? 'Record the meeting first'
                : recordingMeetingId === id
                  ? 'Stop recording first'
                  : undefined
            }
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-700 disabled:opacity-40"
          >
            ✨ Enhance
          </button>
        )}
        <RecordButton meetingId={id} />
      </header>

      {statusDetail && recordingMeetingId === id && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-1 text-xs text-amber-800">
          {statusDetail}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {(meeting?.enhancedJson || isStreamingThis) && (
            <div className="mb-4 flex gap-1 border-b border-stone-200">
              {(['notes', 'enhanced'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                    tab === t
                      ? 'border-amber-600 font-medium text-stone-800'
                      : 'border-transparent text-stone-400 hover:text-stone-600'
                  }`}
                >
                  {t === 'notes' ? 'My notes' : 'Enhanced'}
                </button>
              ))}
            </div>
          )}
          {enhanceError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {enhanceError}
            </div>
          )}
          {enhance.error && tab === 'enhanced' && !enhanceError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {enhance.error}
            </div>
          )}
          <div className={tab === 'notes' ? '' : 'hidden'}>
            {meeting && <NoteEditor meetingId={id} initialContent={meeting.notesJson} />}
          </div>
          {tab === 'enhanced' &&
            (isStreamingThis ? (
              <StreamingPreview markdown={enhance.buffer} />
            ) : meeting?.enhancedJson ? (
              <EnhancedDoc docJson={meeting.enhancedJson} />
            ) : (
              <p className="text-sm text-stone-400">No enhanced notes yet.</p>
            ))}
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
