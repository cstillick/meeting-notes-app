import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MeetingSummary } from '@shared/types'
import ChatDock from '../chat/ChatDock'

function formatDuration(startedAt: number | null, endedAt: number | null): string | null {
  if (!startedAt || !endedAt) return null
  const mins = Math.round((endedAt - startedAt) / 60000)
  if (mins < 1) return '<1 min'
  return `${mins} min`
}

const STATUS_LABEL: Record<string, { label: string; cls: string } | undefined> = {
  recording: { label: 'recording', cls: 'bg-red-100 text-red-700' },
  enhancing: { label: 'enhancing', cls: 'bg-amber-100 text-amber-700' },
  enhanced: { label: 'enhanced', cls: 'bg-green-100 text-green-700' }
}

export default function HomeView(): React.JSX.Element {
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async (q: string) => {
    const result = q.trim()
      ? await window.api.invoke('search:query', q)
      : await window.api.invoke('meetings:list')
    setMeetings(result)
    setReady(true)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void refresh(query), query ? 200 : 0)
    return () => clearTimeout(timer)
  }, [query, refresh])

  async function newNote(): Promise<void> {
    const meeting = await window.api.invoke('meetings:create')
    navigate(`/note/${meeting.id}`)
  }

  async function remove(id: string, title: string): Promise<void> {
    if (!confirm(`Delete "${title || 'Untitled meeting'}"? This also deletes its transcript.`)) {
      return
    }
    await window.api.invoke('meetings:delete', id)
    void refresh(query)
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center justify-between border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <h1 className="text-sm font-semibold tracking-wide text-stone-500">Meetings</h1>
        <div className="flex items-center gap-2">
          <Link
            to="/settings"
            className="rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70"
          >
            Settings
          </Link>
          <button
            onClick={newNote}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
          >
            New note
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 pt-6 pb-24">
        <div className="mx-auto max-w-2xl">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes and transcripts…"
            className="mb-4 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
          />

          {ready && meetings.length === 0 && (
            <div className="mt-20 text-center text-stone-400">
              {query ? (
                <p>No meetings match “{query}”.</p>
              ) : (
                <>
                  <p className="text-lg font-medium">No meetings yet</p>
                  <p className="mt-1 text-sm">
                    Hit <span className="font-medium text-stone-500">New note</span> when your
                    next meeting starts.
                  </p>
                </>
              )}
            </div>
          )}

          <ul className="space-y-1">
            {meetings.map((m) => {
              const status = STATUS_LABEL[m.status]
              const duration = formatDuration(m.startedAt, m.endedAt)
              return (
                <li key={m.id} className="group relative">
                  <Link to={`/note/${m.id}`} className="block rounded-lg px-4 py-3 hover:bg-stone-100">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium">
                        {m.title || 'Untitled meeting'}
                      </span>
                      <span className="shrink-0 text-xs text-stone-400">
                        {new Date(m.createdAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-stone-400">
                      {status && (
                        <span className={`rounded-full px-1.5 py-0.5 font-medium ${status.cls}`}>
                          {status.label}
                        </span>
                      )}
                      {duration && <span>{duration}</span>}
                    </div>
                  </Link>
                  <button
                    onClick={() => void remove(m.id, m.title)}
                    title="Delete meeting"
                    className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md px-2 py-1 text-xs text-stone-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-600"
                  >
                    Delete
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </main>
      <ChatDock meetingId={null} />
    </div>
  )
}
