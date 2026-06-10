import { useEffect, useRef } from 'react'
import type { Bubble } from '../../stores/activeMeetingStore'

function BubbleRow({ bubble, isInterim }: { bubble: Bubble; isInterim?: boolean }): React.JSX.Element {
  const isMe = bubble.channel === 'mic'
  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${
          isMe ? 'rounded-br-sm bg-amber-100 text-amber-950' : 'rounded-bl-sm bg-stone-200 text-stone-800'
        } ${isInterim ? 'italic opacity-60' : ''}`}
      >
        {bubble.text}
      </div>
    </div>
  )
}

export default function TranscriptPanel({
  finals,
  interim
}: {
  finals: Bubble[]
  interim: Partial<Record<'mic' | 'system', Bubble>>
}): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [finals.length, interim.mic?.text, interim.system?.text])

  const empty = finals.length === 0 && !interim.mic && !interim.system

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-xs text-stone-400">
        <span>Them</span>
        <span>Me</span>
      </div>
      {empty && (
        <p className="mt-8 text-center text-sm text-stone-400">
          Transcript will appear here while recording.
        </p>
      )}
      <div className="space-y-1.5">
        {finals.map((b, i) => (
          <BubbleRow key={`${b.startMs}-${i}`} bubble={b} />
        ))}
        {interim.system && <BubbleRow bubble={interim.system} isInterim />}
        {interim.mic && <BubbleRow bubble={interim.mic} isInterim />}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}
