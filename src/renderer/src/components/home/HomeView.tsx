import { useCallback, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLibraryStore } from '../../stores/libraryStore'
import { useImportStore } from '../../stores/importStore'
import ChatDock from '../chat/ChatDock'
import ExportMenu from '../ExportMenu'
import FolderSidebar from './FolderSidebar'
import MeetingList from './MeetingList'

export default function HomeView(): React.JSX.Element {
  const navigate = useNavigate()
  const query = useLibraryStore((s) => s.query)
  const setQuery = useLibraryStore((s) => s.setQuery)
  const folders = useLibraryStore((s) => s.folders)
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId)
  const refreshMeetings = useLibraryStore((s) => s.refreshMeetings)
  const refreshFolders = useLibraryStore((s) => s.refreshFolders)
  const createMeeting = useLibraryStore((s) => s.createMeeting)
  const startPick = useImportStore((s) => s.startPick)
  const pickErrors = useImportStore((s) => s.pickErrors)
  const clearPickErrors = useImportStore((s) => s.clearPickErrors)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    const timer = setTimeout(() => void refreshMeetings(), query ? 200 : 0)
    return () => clearTimeout(timer)
  }, [query, refreshMeetings])

  const newNote = useCallback(async () => {
    const meeting = await createMeeting()
    navigate(`/note/${meeting.id}`)
  }, [createMeeting, navigate])

  // The app ships no Electron menu, so its accelerators live here: ⌘N starts a
  // note in the selected folder, ⌘F jumps to search.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'n') {
        e.preventDefault()
        void newNote()
      } else if (e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [newNote])

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center justify-between border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <h1 className="text-sm font-semibold tracking-wide text-stone-500">Meetings</h1>
        <div className="flex items-center gap-2">
          <ExportMenu
            items={[
              {
                label: 'Export as Obsidian vault',
                hint: selectedFolder
                  ? `"${selectedFolder.name}" as Markdown with [[wikilinks]]`
                  : 'Whole library as Markdown with [[wikilinks]]',
                action: async () => {
                  const result = await window.api.invoke('export:library', selectedFolderId, 'obsidian')
                  if (result === null) return null
                  return result.ok
                    ? `Wrote ${result.files} files to ${result.path}`
                    : (result.error ?? 'Export failed')
                }
              },
              {
                label: 'Export as JSON bundle',
                hint: 'Machine-readable full export — backup or agent corpus',
                action: async () => {
                  const result = await window.api.invoke('export:library', selectedFolderId, 'json')
                  if (result === null) return null
                  return result.ok ? `Saved ${result.path}` : (result.error ?? 'Export failed')
                }
              },
              {
                label: 'Export to Notion',
                hint: selectedFolder
                  ? `"${selectedFolder.name}" as Notion pages`
                  : 'Whole library as Notion pages',
                action: async () => {
                  const result = await window.api.invoke('export:notion', {
                    folderId: selectedFolderId
                  })
                  return result.ok
                    ? `Created ${result.pages} pages: ${result.url}`
                    : (result.error ?? 'Export failed')
                }
              }
            ]}
          />
          <Link
            to="/graph"
            title="Knowledge graph — how your notes tie together"
            className="rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70"
          >
            Graph
          </Link>
          <Link
            to="/settings"
            className="rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70"
          >
            Settings
          </Link>
          <button
            onClick={() => void startPick()}
            title="Transcribe an audio or video file into a new note"
            className="rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70"
          >
            Import
          </button>
          <button
            onClick={() => void newNote()}
            title="New note (⌘N)"
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
          >
            New note
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <FolderSidebar />

        <main className="min-w-0 flex-1 overflow-y-auto px-6 pt-6 pb-24">
          <div className="mx-auto max-w-2xl">
            <label className="mb-4 block">
              <span className="sr-only">Search notes and transcripts</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes and transcripts…"
                className="w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
              />
            </label>

            {pickErrors.length > 0 && (
              <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {pickErrors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
                <button onClick={clearPickErrors} className="mt-1 text-xs underline">
                  Dismiss
                </button>
              </div>
            )}

            <MeetingList />
          </div>
        </main>
      </div>

      <ChatDock meetingId={null} folderId={selectedFolderId} folderName={selectedFolder?.name} />
    </div>
  )
}
