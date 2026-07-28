import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MeetingSummary } from '@shared/types'
import { useLibraryStore } from '../../stores/libraryStore'
import MoveMenu from './MoveMenu'

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

function MeetingRow({
  meeting,
  menuOpen,
  onToggleMenu,
  onCloseMenu
}: {
  meeting: MeetingSummary
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
}): React.JSX.Element {
  const deleteMeeting = useLibraryStore((s) => s.deleteMeeting)
  const status = STATUS_LABEL[meeting.status]
  const duration = formatDuration(meeting.startedAt, meeting.endedAt)
  const title = meeting.title || 'Untitled meeting'

  async function remove(): Promise<void> {
    if (!confirm(`Delete "${title}"? This also deletes its transcript.`)) return
    await deleteMeeting(meeting.id)
  }

  return (
    <li className="group relative">
      <Link to={`/note/${meeting.id}`} className="block rounded-lg px-4 py-3 hover:bg-stone-100">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium">{title}</span>
          <span className="shrink-0 text-xs text-stone-400">
            {new Date(meeting.createdAt).toLocaleString(undefined, {
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

      <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          onClick={onToggleMenu}
          aria-label={`Move ${title} to a folder`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Move to folder"
          className="rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-stone-200 hover:text-stone-600"
        >
          Move
        </button>
        <button
          onClick={() => void remove()}
          aria-label={`Delete ${title}`}
          title="Delete meeting"
          className="rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"
        >
          Delete
        </button>
      </div>

      {menuOpen && (
        <MoveMenu
          meetingId={meeting.id}
          currentFolderId={meeting.folderId}
          onClose={onCloseMenu}
        />
      )}
    </li>
  )
}

export default function MeetingList(): React.JSX.Element {
  const meetings = useLibraryStore((s) => s.meetings)
  const folders = useLibraryStore((s) => s.folders)
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId)
  const query = useLibraryStore((s) => s.query)
  const ready = useLibraryStore((s) => s.ready)
  // Which note's "move to folder" menu is open, if any.
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null)

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null
  const visibleMeetings = useMemo(
    () =>
      selectedFolderId === null
        ? meetings
        : meetings.filter((m) => m.folderId === selectedFolderId),
    [meetings, selectedFolderId]
  )

  return (
    <>
      {ready && visibleMeetings.length === 0 && (
        <div className="mt-20 text-center text-stone-400">
          {query ? (
            <p>No meetings match “{query}”{selectedFolder ? ` in ${selectedFolder.name}` : ''}.</p>
          ) : selectedFolder ? (
            <>
              <p className="text-lg font-medium">{selectedFolder.name} is empty</p>
              <p className="mt-1 text-sm">
                Hit <span className="font-medium text-stone-500">New note</span>, or move a note
                here from its <span className="font-medium text-stone-500">Move</span> menu.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">No meetings yet</p>
              <p className="mt-1 text-sm">
                Hit <span className="font-medium text-stone-500">New note</span> when your next
                meeting starts.
              </p>
            </>
          )}
        </div>
      )}

      <ul className="space-y-1">
        {visibleMeetings.map((m) => (
          <MeetingRow
            key={m.id}
            meeting={m}
            menuOpen={moveMenuId === m.id}
            onToggleMenu={() => setMoveMenuId(moveMenuId === m.id ? null : m.id)}
            onCloseMenu={() => setMoveMenuId(null)}
          />
        ))}
      </ul>
    </>
  )
}
