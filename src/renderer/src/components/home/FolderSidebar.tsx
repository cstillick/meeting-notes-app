import { useRef, useState } from 'react'
import type { Folder } from '@shared/types'
import { useLibraryStore } from '../../stores/libraryStore'

const EDIT_INPUT_CLASS =
  'mb-0.5 w-full rounded-md border border-amber-400 bg-white px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-amber-500 focus:outline-none'

function rowClass(active: boolean): string {
  return `flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
    active ? 'bg-amber-100 font-medium text-amber-900' : 'text-stone-600 hover:bg-stone-200/60'
  }`
}

export default function FolderSidebar(): React.JSX.Element {
  const meetings = useLibraryStore((s) => s.meetings)
  const folders = useLibraryStore((s) => s.folders)
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId)
  const selectFolder = useLibraryStore((s) => s.selectFolder)
  const createFolder = useLibraryStore((s) => s.createFolder)
  const renameFolder = useLibraryStore((s) => s.renameFolder)
  const deleteFolder = useLibraryStore((s) => s.deleteFolder)

  // Inline folder editing (Electron's renderer has no window.prompt, so we use
  // an in-place input instead). `creating` shows the new-folder input;
  // `renamingId` swaps a folder row for an edit input. `draft` is the text in
  // whichever input is open.
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Guards against Enter + blur both firing a commit (double-create/rename).
  const committing = useRef(false)

  function cancelEdit(): void {
    setCreating(false)
    setRenamingId(null)
    setDraft('')
  }

  function startNew(): void {
    setRenamingId(null)
    setDraft('')
    setCreating(true)
  }

  function startRename(folder: Folder): void {
    setCreating(false)
    setRenamingId(folder.id)
    setDraft(folder.name)
  }

  async function commit(action: (name: string) => Promise<void>): Promise<void> {
    if (committing.current) return
    committing.current = true
    const name = draft
    cancelEdit()
    try {
      await action(name)
    } finally {
      committing.current = false
    }
  }

  async function onDelete(folder: Folder): Promise<void> {
    if (!confirm(`Delete folder "${folder.name}"? Its notes are kept and moved to All notes.`)) {
      return
    }
    await deleteFolder(folder.id)
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 bg-stone-50/60 px-2 py-4">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
          Folders
        </span>
        <button
          onClick={startNew}
          aria-label="New folder"
          title="New folder"
          className="rounded px-1.5 text-stone-400 hover:bg-stone-200/70 hover:text-stone-600"
        >
          +
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto">
        {creating && (
          <input
            autoFocus
            aria-label="New folder name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(createFolder)
              else if (e.key === 'Escape') cancelEdit()
            }}
            onBlur={() => void commit(createFolder)}
            placeholder="Folder name"
            className={EDIT_INPUT_CLASS}
          />
        )}
        <button
          onClick={() => selectFolder(null)}
          aria-current={selectedFolderId === null || undefined}
          className={rowClass(selectedFolderId === null)}
        >
          <span>All notes</span>
          <span className="text-xs text-stone-400">{meetings.length}</span>
        </button>

        {folders.map((f) => {
          const count = meetings.filter((m) => m.folderId === f.id).length
          const active = selectedFolderId === f.id
          if (renamingId === f.id) {
            return (
              <input
                key={f.id}
                autoFocus
                aria-label={`Rename folder ${f.name}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commit((name) => renameFolder(f.id, name))
                  else if (e.key === 'Escape') cancelEdit()
                }}
                onBlur={() => void commit((name) => renameFolder(f.id, name))}
                className={EDIT_INPUT_CLASS}
              />
            )
          }
          return (
            <div key={f.id} className="group relative">
              <button
                onClick={() => selectFolder(f.id)}
                aria-current={active || undefined}
                className={rowClass(active)}
              >
                <span className="truncate">{f.name}</span>
                <span className="text-xs text-stone-400 group-hover:hidden group-focus-within:hidden">
                  {count}
                </span>
              </button>
              <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  onClick={() => startRename(f)}
                  aria-label={`Rename folder ${f.name}`}
                  title="Rename folder"
                  className="rounded px-1 text-xs text-stone-400 hover:bg-stone-200 hover:text-stone-600"
                >
                  ✎
                </button>
                <button
                  onClick={() => void onDelete(f)}
                  aria-label={`Delete folder ${f.name}`}
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
  )
}
