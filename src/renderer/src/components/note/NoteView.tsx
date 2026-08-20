import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Channel, Meeting } from '@shared/types'
import { useActiveMeetingStore, type Bubble } from '../../stores/activeMeetingStore'
import { useEnhanceStore } from '../../stores/enhanceStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useImportStore } from '../../stores/importStore'
import ExportMenu from '../ExportMenu'
import NoteEditor from './NoteEditor'
import RelatedNotes from './RelatedNotes'
import TranscriptPanel from './TranscriptPanel'
import { EnhancedDoc, MarkdownPreview, StreamingPreview } from './EnhancedView'
import ChatDock from '../chat/ChatDock'
import { registerFlush } from '../../flush'

// Stable empty references: zustand selectors must not mint a new object per call.
const NO_BUBBLES: Bubble[] = []
const NO_INTERIM: Partial<Record<Channel, Bubble>> = {}

function RecordButton({ meetingId }: { meetingId: string }): React.JSX.Element {
  const recorderState = useActiveMeetingStore((s) => s.recorderState)
  const recordingMeetingId = useActiveMeetingStore((s) => s.recordingMeetingId)
  const micLevel = useActiveMeetingStore((s) => s.micLevel)
  const micMuted = useActiveMeetingStore((s) => s.micMuted)
  const lastError = useActiveMeetingStore((s) => s.lastError)
  const startRecording = useActiveMeetingStore((s) => s.startRecording)
  const stopRecording = useActiveMeetingStore((s) => s.stopRecording)
  // The mic permission prompt can hold startRecording for seconds; recorderState
  // only arrives from main after that, so track the click locally too.
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | null>(null)

  const isThisMeeting = recordingMeetingId === meetingId
  const recording = isThisMeeting && (recorderState === 'recording' || recorderState === 'starting')
  const busy = recorderState === 'starting' || recorderState === 'stopping'
  const blocked = !isThisMeeting && recordingMeetingId !== null && recorderState !== 'idle'
  const starting = pendingAction === 'start' || (isThisMeeting && recorderState === 'starting')
  const stopping = pendingAction === 'stop' || (isThisMeeting && recorderState === 'stopping')

  async function toggle(): Promise<void> {
    if (pendingAction) return
    const action = recording ? 'stop' : 'start'
    setPendingAction(action)
    try {
      if (action === 'stop') {
        await stopRecording()
      } else {
        await startRecording(meetingId)
      }
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {lastError && (
        <span className="max-w-xs truncate text-xs text-red-600" title={lastError}>
          {lastError}
        </span>
      )}
      {recording && micMuted && (
        <span
          className="text-xs font-medium text-stone-400"
          title="Microphone muted — recording system audio only"
        >
          Mic off
        </span>
      )}
      {recording && !micMuted && (
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
        disabled={busy || blocked || pendingAction !== null}
        title={blocked ? 'Another meeting is recording' : undefined}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm disabled:opacity-50 ${
          recording
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-stone-800 text-white hover:bg-stone-900'
        }`}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            recording ? 'animate-pulse bg-[#ffffff]' : 'bg-red-500'
          }`}
        />
        {starting ? 'Starting…' : stopping ? 'Stopping…' : recording ? 'Stop' : 'Record'}
      </button>
    </div>
  )
}

/** Owns the transcript subscriptions so a segment doesn't re-render the editor,
 *  the enhanced doc and the chat dock alongside it. */
function TranscriptSidebar({ meetingId }: { meetingId: string }): React.JSX.Element {
  const finals = useActiveMeetingStore((s) =>
    s.recordingMeetingId === meetingId
      ? s.finals
      : s.viewFinalsId === meetingId
        ? s.viewFinals
        : NO_BUBBLES
  )
  const interim = useActiveMeetingStore((s) =>
    s.recordingMeetingId === meetingId ? s.interim : NO_INTERIM
  )
  return <TranscriptPanel finals={finals} interim={interim} />
}

/** Keeps the ~10/sec streaming buffer out of NoteView's own subscriptions. */
function StreamingBuffer(): React.JSX.Element {
  const buffer = useEnhanceStore((s) => s.buffer)
  return <StreamingPreview markdown={buffer} />
}

export default function NoteView(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [title, setTitle] = useState('')
  const [showTranscript, setShowTranscript] = useState(true)
  const [tab, setTab] = useState<'notes' | 'enhanced'>('notes')
  const [enhanceError, setEnhanceError] = useState<string | null>(null)

  const recordingMeetingId = useActiveMeetingStore((s) => s.recordingMeetingId)
  const statusDetail = useActiveMeetingStore((s) => s.statusDetail)
  const degraded = useActiveMeetingStore((s) => s.degraded.length > 0)
  const hasTranscript = useActiveMeetingStore((s) =>
    s.recordingMeetingId === id
      ? s.finals.length > 0
      : s.viewFinalsId === id && s.viewFinals.length > 0
  )
  const streamingId = useEnhanceStore((s) => s.streamingId)
  const savedVersion = useEnhanceStore((s) => s.savedVersion)
  const savedFor = useEnhanceStore((s) => s.savedFor)
  const streamError = useEnhanceStore((s) => (s.errorFor === id ? s.error : null))
  const streamErrorRetryable = useEnhanceStore((s) => s.errorRetryable)
  const partial = useEnhanceStore((s) => (s.errorFor === id ? s.partial : null))
  const startEnhance = useEnhanceStore((s) => s.start)
  const cancelEnhance = useEnhanceStore((s) => s.cancel)

  // Title is written on a debounce, so remember what is persisted and what is
  // still queued — a reload must not clobber an edit in progress.
  const savedTitle = useRef('')
  const pendingTitle = useRef<string | null>(null)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewedId = useRef(id)

  useEffect(() => {
    viewedId.current = id
  }, [id])

  const reload = useCallback(() => {
    if (!id) return
    void window.api.invoke('meetings:get', id).then((result) => {
      if (!result || viewedId.current !== id) return
      setMeeting(result.meeting)
      savedTitle.current = result.meeting.title
      if (pendingTitle.current === null) setTitle(result.meeting.title)
      useActiveMeetingStore.getState().loadFinals(
        id,
        result.segments.map((s) => ({
          channel: s.channel,
          text: s.text,
          startMs: s.startMs,
          speaker: s.speaker ?? undefined
        }))
      )
    })
  }, [id])

  useEffect(() => reload(), [reload])

  // Reload when an enhancement result lands (updates doc + maybe auto-title).
  // savedVersion is a running counter, so only react to a change, and only to
  // one for this note.
  const seenSavedVersion = useRef(savedVersion)
  useEffect(() => {
    if (savedVersion === seenSavedVersion.current) return
    seenSavedVersion.current = savedVersion
    if (savedFor !== id) return
    reload()
    setTab('enhanced')
  }, [savedVersion, savedFor, id, reload])

  const importStatus = useImportStore((s) => (id ? s.statuses[id] : undefined))
  const dismissImportError = useImportStore((s) => s.dismissError)

  // Reload when an out-of-process agent (MCP) changed this note. The editor
  // itself decides whether adopting the new content is safe (NoteEditor).
  const externallyChanged = useLibraryStore((s) => s.externallyChanged)
  const seenExternalVersion = useRef(externallyChanged.version)
  useEffect(() => {
    if (externallyChanged.version === seenExternalVersion.current) return
    seenExternalVersion.current = externallyChanged.version
    if (!id || !externallyChanged.noteIds.includes(id)) return
    reload()
  }, [externallyChanged, id, reload])

  const isStreamingThis = streamingId === id

  async function onEnhance(): Promise<void> {
    if (!id) return
    setEnhanceError(null)
    setTab('enhanced')
    const err = await startEnhance(id)
    if (err) setEnhanceError(err)
  }

  const commitTitle = useCallback(
    (value: string) => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current)
        titleTimer.current = null
      }
      pendingTitle.current = null
      if (!id || value === savedTitle.current) return
      savedTitle.current = value
      void window.api.invoke('meetings:updateTitle', id, value)
    },
    [id]
  )

  const editTitle = useCallback(
    (value: string) => {
      setTitle(value)
      pendingTitle.current = value
      if (titleTimer.current) clearTimeout(titleTimer.current)
      titleTimer.current = setTimeout(() => {
        titleTimer.current = null
        commitTitle(value)
      }, 500)
    },
    [commitTitle]
  )

  // The window can be torn down without unmounting React (close / quit), so
  // flush the queued title on pagehide as well as on unmount — and on quit via
  // the registry, since app.exit skips pagehide.
  useEffect(() => {
    const flush = (): void => {
      if (pendingTitle.current !== null) commitTitle(pendingTitle.current)
    }
    window.addEventListener('pagehide', flush)
    const unregister = registerFlush(flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      unregister()
      flush()
    }
  }, [commitTitle])

  if (!id) return <div />

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center gap-3 border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-700">
          ←
        </Link>
        <input
          value={title}
          onChange={(e) => editTitle(e.target.value)}
          onBlur={(e) => commitTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitTitle(e.currentTarget.value)
              e.currentTarget.blur()
            }
          }}
          placeholder="Untitled meeting"
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-stone-800 placeholder-stone-400 focus:outline-none"
        />
        <ExportMenu
          items={[
            ...(['md', 'html', 'pdf', 'docx'] as const).map((format) => ({
              label: `Export as ${format === 'md' ? 'Markdown' : format.toUpperCase()}`,
              action: async () => {
                const result = await window.api.invoke('export:note', id, format)
                if (result === null) return null
                return result.ok ? `Saved ${result.path}` : (result.error ?? 'Export failed')
              }
            })),
            {
              label: 'Export to Notion',
              hint: 'Uses the token and parent page from Settings',
              action: async () => {
                const result = await window.api.invoke('export:notion', { noteId: id })
                return result.ok ? `Created ${result.url}` : (result.error ?? 'Export failed')
              }
            }
          ]}
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
            onClick={() => cancelEnhance()}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onEnhance}
            disabled={recordingMeetingId === id || !hasTranscript}
            title={
              !hasTranscript
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

      {importStatus?.state === 'transcribing' && (
        <div className="border-b border-sky-200 bg-sky-50 px-6 py-1 text-xs text-sky-800">
          Transcribing the imported recording — the transcript appears here when it finishes.
        </div>
      )}
      {importStatus?.state === 'error' && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-1 text-xs text-red-700">
          <span>Import failed: {importStatus.message}</span>
          <button onClick={() => dismissImportError(id)} className="underline">
            Dismiss
          </button>
        </div>
      )}

      {statusDetail && recordingMeetingId === id && (
        <div
          className={`border-b px-6 py-1 text-xs ${
            degraded
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {statusDetail}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-24">
          {meeting && (
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
          {streamError && tab === 'enhanced' && !enhanceError && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <span className="min-w-0 break-words">{streamError}</span>
              {streamErrorRetryable && (
                <button
                  onClick={() => void onEnhance()}
                  className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs font-medium hover:bg-red-100"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {partial && tab === 'enhanced' && !isStreamingThis && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/60 p-3">
              <p className="mb-2 text-xs font-medium text-amber-800">
                Partial result — not saved. Retry to regenerate, or copy what you need.
              </p>
              <MarkdownPreview markdown={partial} />
            </div>
          )}
          <div className={tab === 'notes' ? '' : 'hidden'}>
            {meeting && <NoteEditor meetingId={id} initialContent={meeting.notesJson} />}
          </div>
          {/* Kept mounted (hidden) when inactive so in-progress edits survive tab switches. */}
          <div className={tab === 'enhanced' ? '' : 'hidden'}>
            {isStreamingThis ? (
              <StreamingBuffer />
            ) : meeting?.enhancedJson ? (
              <EnhancedDoc meetingId={id} docJson={meeting.enhancedJson} />
            ) : (
              <p className="text-sm text-stone-400">No enhanced notes yet.</p>
            )}
          </div>
          <RelatedNotes meetingId={id} />
        </main>
        {showTranscript && (
          <aside className="w-80 shrink-0 border-l border-stone-200 bg-stone-100/60">
            <TranscriptSidebar meetingId={id} />
          </aside>
        )}
      </div>
      <ChatDock meetingId={id} />
    </div>
  )
}
