import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Folder, MeetingSummary } from '@shared/types'
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
  const [folders, setFolders] = useState<Folder[]>([])
  // null = "All notes"; a folder id scopes the list and the chat to that folder.
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  // Which note's "move to folder" menu is open, if any.
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null)

  const refresh = useCallback(async (q: string) => {
    const result = q.trim()
      ? await window.api.invoke('search:query', q)
      : await window.api.invoke('meetings:list')
    setMeetings(result)
    setReady(true)
  }, [])

  const refreshFolders = useCallback(async () => {
    setFolders(await window.api.invoke('folders:list'))
  }, [])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    const timer = setTimeout(() => void refresh(query), query ? 200 : 0)
    return () => clearTimeout(timer)
  }, [query, refresh])

  // The selected folder may be deleted from under us; fall back to All notes.
  useEffect(() => {
    if (selectedFolderId && !folders.some((f) => f.id === selectedFolderId)) {
      setSelectedFolderId(null)
    }
  }, [folders, selectedFolderId])

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null
  const visibleMeetings = useMemo(
    () =>
      selectedFolderId === null
        ? meetings
        : meetings.filter((m) => m.folderId === selectedFolderId),
    [meetings, selectedFolderId]
  )

  async function newNote(): Promise<void> {
    const meeting = await window.api.invoke('meetings:create')
    if (selectedFolderId) {
      await window.api.invoke('meetings:setFolder', meeting.id, selectedFolderId)
    }
    navigate(`/note/${meeting.id}`)
  }

  async function newFolder(): Promise<void> {
    const name = prompt('Folder name')?.trim()
    if (!name) return
    const folder = await window.api.invoke('folders:create', name)
    await refreshFolders()
    setSelectedFolderId(folder.id)
  }

  async function renameFolder(folder: Folder): Promise<void> {
    const name = prompt('Rename folder', folder.name)?.trim()
    if (!name || name === folder.name) return
    await window.api.invoke('folders:rename', folder.id, name)
    void refreshFolders()
  }

  async function deleteFolder(folder: Folder): Promise<void> {
    if (!confirm(`Delete folder "${folder.name}"? Its notes are kept and moved to All notes.`)) {
      return
    }
    await window.api.invoke('folders:delete', folder.id)
    if (selectedFolderId === folder.id) setSelectedFolderId(null)
    await refreshFolders()
    void refresh(query)
  }

  async function moveToFolder(meetingId: string, folderId: string | null): Promise<void> {
    setMoveMenuId(null)
    await window.api.invoke('meetings:setFolder', meetingId, folderId)
    void refresh(query)
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

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 bg-stone-50/60 px-2 py-4">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
              Folders
            </span>
            <button
              onClick={() => void newFolder()}
              title="New folder"
              className="rounded px-1.5 text-stone-400 hover:bg-stone-200/70 hover:text-stone-600"
            >
              +
            </button>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto">
            <button
              onClick={() => setSelectedFolderId(null)}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
                selectedFolderId === null
                  ? 'bg-amber-100 font-medium text-amber-900'
                  : 'text-stone-600 hover:bg-stone-200/60'
              }`}
            >
              <span>All notes</span>
              <span className="text-xs text-stone-400">{meetings.length}</span>
            </button>

            {folders.map((f) => {
              const count = meetings.filter((m) => m.folderId === f.id).length
              const active = selectedFolderId === f.id
              return (
                <div key={f.id} className="group relative">
                  <button
                    onClick={() => setSelectedFolderId(f.id)}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
                      active
                        ? 'bg-amber-100 font-medium text-amber-900'
                        : 'text-stone-600 hover:bg-stone-200/60'
                    }`}
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="text-xs text-stone-400 group-hover:hidden">{count}</span>
                  </button>
                  <div className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                    <button
                      onClick={() => void renameFolder(f)}
                      title="Rename folder"
                      className="rounded px-1 text-xs text-stone-400 hover:bg-stone-200 hover:text-stone-600"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => void deleteFolder(f)}
                      title="Delete folder"
                      className="rounded px-1 text-xs text-stone-400 hover:bg-red-100 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-6 pt-6 pb-24">
          <div className="mx-auto max-w-2xl">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes and transcripts…"
              className="mb-4 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
            />

            {ready && visibleMeetings.length === 0 && (
              <div className="mt-20 text-center text-stone-400">
                {query ? (
                  <p>No meetings match “{query}”{selectedFolder ? ` in ${selectedFolder.name}` : ''}.</p>
                ) : selectedFolder ? (
                  <>
                    <p className="text-lg font-medium">{selectedFolder.name} is empty</p>
                    <p className="mt-1 text-sm">
                      Hit <span className="font-medium text-stone-500">New note</span>, or move a
                      note here from its <span className="font-medium text-stone-500">Move</span>{' '}
                      menu.
                    </p>
                  </>
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
              {visibleMeetings.map((m) => {
                const status = STATUS_LABEL[m.status]
                const duration = formatDuration(m.startedAt, m.endedAt)
                return (
                  <li key={m.id} className="group relative">
                    <Link
                      to={`/note/${m.id}`}
                      className="block rounded-lg px-4 py-3 hover:bg-stone-100"
                    >
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

                    <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => setMoveMenuId(moveMenuId === m.id ? null : m.id)}
                        title="Move to folder"
                        className="rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-stone-200 hover:text-stone-600"
                      >
                        Move
                      </button>
                      <button
                        onClick={() => void remove(m.id, m.title)}
                        title="Delete meeting"
                        className="rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </div>

                    {moveMenuId === m.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMoveMenuId(null)} />
                        <div className="absolute top-12 right-3 z-20 w-52 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-xl">
                          <p className="px-3 py-1 text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
                            Move to
                          </p>
                          <button
                            onClick={() => void moveToFolder(m.id, null)}
                            disabled={m.folderId === null}
                            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-100 disabled:text-stone-300"
                          >
                            No folder
                            {m.folderId === null && <span className="text-amber-600">✓</span>}
                          </button>
                          {folders.length === 0 && (
                            <p className="px-3 py-1.5 text-xs text-stone-400">
                              No folders yet — use + above.
                            </p>
                          )}
                          {folders.map((f) => (
                            <button
                              key={f.id}
                              onClick={() => void moveToFolder(m.id, f.id)}
                              disabled={m.folderId === f.id}
                              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-100 disabled:text-stone-300"
                            >
                              <span className="truncate">{f.name}</span>
                              {m.folderId === f.id && <span className="text-amber-600">✓</span>}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </main>
      </div>

      <ChatDock
        meetingId={null}
        folderId={selectedFolderId}
        folderName={selectedFolder?.name}
      />
    </div>
  )
}
