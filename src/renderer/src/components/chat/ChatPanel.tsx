import { useEffect, useRef } from 'react'
import { useChatStore, chatKeyOf } from '../../stores/chatStore'
import ChatMessageBubble from './ChatMessageBubble'
import { ChatMarkdown } from './ChatMarkdown'

export default function ChatPanel({
  meetingId,
  folderId = null,
  folderName,
  onClose
}: {
  meetingId: string | null
  folderId?: string | null
  folderName?: string
  onClose: () => void
}): React.JSX.Element {
  const chatKey = chatKeyOf(meetingId, folderId)
  const thread = useChatStore((s) => s.threads[chatKey])
  const { send, clear } = useChatStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  const messages = thread?.messages ?? []
  const streaming = thread?.streaming ?? false
  const streamBuffer = thread?.streamBuffer ?? ''
  const error = thread?.error ?? null

  // Keep the latest message in view as answers stream in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, streamBuffer, streaming, error])

  async function onClear(): Promise<void> {
    if (messages.length === 0) return
    if (!confirm('Clear this conversation?')) return
    await clear(meetingId, folderId)
  }

  return (
    <div className="absolute bottom-full mb-2 flex max-h-[60vh] w-full flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl">
      <header className="flex shrink-0 items-center justify-between border-b border-stone-100 px-4 py-2.5">
        <span className="text-xs font-semibold tracking-wide text-stone-500">
          {meetingId
            ? 'Ask about this meeting'
            : folderId
              ? `Ask across ${folderName || 'this folder'}`
              : 'Ask across all meetings'}
        </span>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={() => void onClear()}
              className="rounded px-2 py-0.5 text-xs text-stone-400 hover:bg-stone-100 hover:text-stone-600"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded px-2 py-0.5 text-xs text-stone-400 hover:bg-stone-100 hover:text-stone-600"
          >
            ✕
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !streaming && !error && (
          <p className="py-6 text-center text-sm text-stone-400">
            {meetingId
              ? 'Ask anything about this meeting — works while it’s still recording.'
              : folderId
                ? `Ask anything about the notes in ${folderName || 'this folder'} — answers only use this folder.`
                : 'Ask anything about your meetings, like “what did we decide about pricing?”'}
          </p>
        )}

        {messages.map((m) => (
          <ChatMessageBubble key={m.id} message={m} />
        ))}

        {streaming && streamBuffer === '' && (
          <div className="flex items-center gap-1 py-1" aria-label="Thinking">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        )}

        {streaming && streamBuffer !== '' && (
          <div>
            <ChatMarkdown markdown={streamBuffer} />
            <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse bg-amber-500" />
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="min-w-0 break-words">{error}</span>
            {thread?.lastQuestion && (
              <button
                onClick={() => void send(meetingId, folderId, thread.lastQuestion!)}
                className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs font-medium hover:bg-red-100"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
