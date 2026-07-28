import { useEffect, useRef } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'

const ITEM_CLASS =
  'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-100 disabled:text-stone-300'

/** Per-row "move to folder" popover. Dismissed by Escape, by focus leaving it,
 *  or by a click on the backdrop. */
export default function MoveMenu({
  meetingId,
  currentFolderId,
  onClose
}: {
  meetingId: string
  currentFolderId: string | null
  onClose: () => void
}): React.JSX.Element {
  const folders = useLibraryStore((s) => s.folders)
  const moveToFolder = useLibraryStore((s) => s.moveToFolder)
  const menuRef = useRef<HTMLDivElement>(null)

  // Pull focus in so Escape and Tab reach the menu without a pointer.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [])

  async function move(folderId: string | null): Promise<void> {
    onClose()
    await moveToFolder(meetingId, folderId)
  }

  return (
    <>
      <div className="fixed inset-0 z-10" aria-hidden onClick={onClose} />
      <div
        ref={menuRef}
        role="menu"
        aria-label="Move to folder"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onClose()
        }}
        className="absolute top-12 right-3 z-20 w-52 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-xl"
      >
        <p className="px-3 py-1 text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
          Move to
        </p>
        <button
          role="menuitem"
          onClick={() => void move(null)}
          disabled={currentFolderId === null}
          className={ITEM_CLASS}
        >
          No folder
          {currentFolderId === null && <span className="text-amber-600">✓</span>}
        </button>
        {folders.length === 0 && (
          <p className="px-3 py-1.5 text-xs text-stone-400">No folders yet — use + above.</p>
        )}
        {folders.map((f) => (
          <button
            key={f.id}
            role="menuitem"
            onClick={() => void move(f.id)}
            disabled={currentFolderId === f.id}
            className={ITEM_CLASS}
          >
            <span className="truncate">{f.name}</span>
            {currentFolderId === f.id && <span className="text-amber-600">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}
