import type { ChatMessage } from '@shared/types'
import { ChatMarkdown, CopyButton } from './ChatMarkdown'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function ChatMessageBubble({
  message
}: {
  message: ChatMessage
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-amber-100/80 px-3.5 py-2 text-sm whitespace-pre-wrap text-stone-800">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="group">
      <ChatMarkdown markdown={message.content} />
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[11px] text-stone-300">{relativeTime(message.createdAt)}</span>
        <CopyButton text={message.content} />
      </div>
    </div>
  )
}
