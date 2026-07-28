import { useEffect, useRef, useState } from 'react'
import { useChatStore, chatKeyOf } from '../../stores/chatStore'
import ChatPanel from './ChatPanel'

/** Floating Granola-style "ask anything" bar with an expandable answer panel.
 *  meetingId scopes questions to one meeting; otherwise folderId scopes them to
 *  one folder's notes; with neither set, it asks across all notes. */
export default function ChatDock({
  meetingId,
  folderId = null,
  folderName
}: {
  meetingId: string | null
  folderId?: string | null
  folderName?: string
}): React.JSX.Element {
  const chatKey = chatKeyOf(meetingId, folderId)
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const open = useChatStore((s) => s.openKey === chatKey)
  const streaming = useChatStore((s) => s.threads[chatKey]?.streaming ?? false)
  const { send, cancel, loadHistory, setOpen } = useChatStore()

  useEffect(() => {
    void loadHistory(chatKey)
  }, [chatKey, loadHistory])

  // ⌘K focuses the bar, Esc collapses the panel.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(chatKey)
      } else if (e.key === 'Escape' && useChatStore.getState().openKey === chatKey) {
        setOpen(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [chatKey, setOpen])

  function submit(): void {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')
    setOpen(chatKey)
    void send(meetingId, folderId, q)
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-40 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2">
      {open && (
        <ChatPanel
          meetingId={meetingId}
          folderId={folderId}
          folderName={folderName}
          onClose={() => setOpen(null)}
        />
      )}

      <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-1.5 pl-4 shadow-lg">
        <span className="shrink-0 text-amber-500" aria-hidden>
          ✦
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          onFocus={() => setOpen(chatKey)}
          placeholder={
            meetingId
              ? 'Ask anything about this meeting…'
              : folderId
                ? `Ask across notes in ${folderName || 'this folder'}…`
                : 'Ask across all your meetings…'
          }
          className="min-w-0 flex-1 bg-transparent text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none"
        />
        <kbd className="hidden shrink-0 rounded border border-stone-200 px-1.5 py-0.5 text-[10px] text-stone-400 sm:inline">
          ⌘K
        </kbd>
        {streaming ? (
          <button
            onClick={() => cancel(chatKey)}
            title="Stop answering"
            className="shrink-0 rounded-full bg-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-300"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!input.trim()}
            className="shrink-0 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-40"
          >
            Ask
          </button>
        )}
      </div>
    </div>
  )
}
