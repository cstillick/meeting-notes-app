import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MeetingSummary } from '@shared/types'

export default function HomeView(): React.JSX.Element {
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    window.api
      .invoke('meetings:list')
      .then(setMeetings)
      .catch(() => setMeetings([]))
      .finally(() => setReady(true))
  }, [])

  async function newNote(): Promise<void> {
    const meeting = await window.api.invoke('meetings:create')
    navigate(`/note/${meeting.id}`)
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

      <main className="flex-1 overflow-y-auto px-6 py-6">
        {ready && meetings.length === 0 && (
          <div className="mt-24 text-center text-stone-400">
            <p className="text-lg font-medium">No meetings yet</p>
            <p className="mt-1 text-sm">
              Hit <span className="font-medium text-stone-500">New note</span> when your next
              meeting starts.
            </p>
          </div>
        )}
        <ul className="mx-auto max-w-2xl space-y-1">
          {meetings.map((m) => (
            <li key={m.id}>
              <Link
                to={`/note/${m.id}`}
                className="block rounded-lg px-4 py-3 hover:bg-stone-100"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{m.title || 'Untitled meeting'}</span>
                  <span className="text-xs text-stone-400">
                    {new Date(m.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
