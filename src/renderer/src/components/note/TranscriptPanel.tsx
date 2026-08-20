import { memo, useEffect, useMemo, useRef } from 'react'
import type { Bubble } from '../../stores/activeMeetingStore'

// Distinct bubble colors per diarized speaker on the system channel; the
// palette wraps for meetings with more speakers than entries.
const SPEAKER_PALETTE = [
  'bg-stone-200 text-stone-800',
  'bg-sky-100 text-sky-950',
  'bg-emerald-100 text-emerald-950',
  'bg-violet-100 text-violet-950'
]

function speakerLabel(bubble: Bubble): string {
  if (bubble.channel === 'mic') return 'Me'
  return bubble.speaker === undefined ? 'Them' : `Speaker ${bubble.speaker + 1}`
}

function BubbleRow({
  bubble,
  isInterim,
  showLabel
}: {
  bubble: Bubble
  isInterim?: boolean
  showLabel?: boolean
}): React.JSX.Element {
  const isMe = bubble.channel === 'mic'
  const color = isMe
    ? 'rounded-br-sm bg-amber-100 text-amber-950'
    : `rounded-bl-sm ${SPEAKER_PALETTE[(bubble.speaker ?? 0) % SPEAKER_PALETTE.length]}`
  return (
    <div className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
      {showLabel && !isMe && (
        <span className="mb-0.5 px-1 text-[10px] text-stone-400">{speakerLabel(bubble)}</span>
      )}
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${color} ${
          isInterim ? 'italic opacity-60' : ''
        }`}
      >
        {bubble.text}
      </div>
    </div>
  )
}

function TranscriptPanel({
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

  // Caption a system bubble only when its speaker differs from the previous
  // system bubble — avoids a label on every line of one person's run. One
  // forward pass, so a long run doesn't degrade toward O(n²).
  const showLabels = useMemo(() => {
    let seenSystem = false
    let lastSpeaker: number | undefined
    return finals.map((b) => {
      if (b.channel !== 'system') return false
      const show = !seenSystem || lastSpeaker !== b.speaker
      seenSystem = true
      lastSpeaker = b.speaker
      return show
    })
  }, [finals])

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
          <BubbleRow key={`${b.startMs}-${i}`} bubble={b} showLabel={showLabels[i]} />
        ))}
        {interim.system && <BubbleRow bubble={interim.system} isInterim />}
        {interim.mic && <BubbleRow bubble={interim.mic} isInterim />}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}

export default memo(TranscriptPanel)
