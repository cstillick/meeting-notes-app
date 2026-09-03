import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Channel, SpeakerIdentity } from '@shared/types'
import type { Bubble, SpeakerSuggestion } from '../../stores/activeMeetingStore'
import {
  SPEAKER_DOT,
  SPEAKER_PALETTE,
  SPEAKER_RAIL,
  defaultSpeakerLabel,
  formatTalkTime,
  paletteIndex,
  speakerKey
} from '../../lib/speakers'

/** Above this many distinct voices the alternating-bubble layout stops working:
 *  85%-wide bubbles in a sidebar are unreadable at five speakers, and a lecture
 *  has no "Them"/"Me" duality to alternate across in the first place. */
const CONVERSATION_MAX_SPEAKERS = 3

type Layout = 'conversation' | 'document'

function timestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

interface Resolved {
  label: string
  identity: SpeakerIdentity | undefined
  /** Right-aligned as the user's own voice. Follows resolved identity, not
   *  channel: the channel stopped meaning "the user" the moment the mic could
   *  carry several people. */
  isMe: boolean
  colorIndex: number
}

function BubbleRow({
  bubble,
  resolved,
  layout,
  isInterim,
  showLabel
}: {
  bubble: Bubble
  resolved: Resolved
  layout: Layout
  isInterim?: boolean
  showLabel?: boolean
}): React.JSX.Element {
  if (layout === 'document') {
    return (
      <div className={`flex flex-col ${isInterim ? 'italic opacity-60' : ''}`}>
        {showLabel && (
          <span className="mt-2 mb-0.5 text-[11px] font-semibold text-stone-500">
            {resolved.label}
          </span>
        )}
        <div className={`flex gap-2 border-l-2 pl-2 ${SPEAKER_RAIL[resolved.colorIndex]}`}>
          <span className="w-9 shrink-0 pt-0.5 text-[10px] tabular-nums text-stone-400">
            {timestamp(bubble.startMs)}
          </span>
          <span className="text-sm leading-snug text-stone-700">{bubble.text}</span>
        </div>
      </div>
    )
  }
  const color = resolved.isMe
    ? 'rounded-br-sm bg-amber-100 text-amber-950'
    : `rounded-bl-sm ${SPEAKER_PALETTE[resolved.colorIndex]}`
  return (
    <div className={`flex flex-col ${resolved.isMe ? 'items-end' : 'items-start'}`}>
      {showLabel && (
        <span className="mb-0.5 px-1 text-[10px] text-stone-400">{resolved.label}</span>
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

/** Rename / "this is me" / merge for one voice. Commits on Enter or blur — a
 *  discrete commit, not the debounced autosave the title field uses, because a
 *  half-typed name would be written to every line of the transcript. */
function SpeakerPopover({
  entry,
  others,
  onRename,
  onSetMe,
  onMerge,
  onClose
}: {
  entry: SpeakerIdentity
  others: SpeakerIdentity[]
  onRename: (name: string) => void
  onSetMe: () => void
  onMerge: (intoIdentityId: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(entry.name ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const commit = (): void => {
    if (draft.trim() !== (entry.name ?? '')) onRename(draft.trim())
    onClose()
  }
  // Focus moving to another control INSIDE the popover must not commit-and-close
  // it. stopPropagation on the target's mousedown does not help — the default
  // action still moves focus — which made the merge select unreachable: the blur
  // unmounted the popover before its onChange could fire.
  const onInputBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    if (popoverRef.current?.contains(e.relatedTarget as Node | null)) return
    commit()
  }
  return (
    <div
      ref={popoverRef}
      className="absolute top-7 left-0 z-10 w-60 rounded-lg border border-stone-200 bg-white p-2 shadow-lg"
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') onClose()
        }}
        onBlur={onInputBlur}
        maxLength={60}
        placeholder={defaultSpeakerLabel(entry.channel, entry.speaker)}
        className="w-full rounded border border-stone-300 px-2 py-1 text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
      />
      <p className="mt-1 text-[10px] text-stone-400">
        {entry.lineCount} lines · {formatTalkTime(entry.talkMs)}
        {entry.source === 'suggested' && ' · suggested'}
      </p>
      <button
        type="button"
        // onMouseDown, not onClick: the input's onBlur commit would otherwise
        // unmount this popover before the click landed.
        onMouseDown={(e) => {
          e.preventDefault()
          onSetMe()
          onClose()
        }}
        disabled={entry.isMe}
        className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-stone-600 hover:bg-stone-100 disabled:text-stone-300 disabled:hover:bg-transparent"
      >
        {entry.isMe ? '✓ This is me' : 'This is me'}
      </button>
      {entry.identityId !== null && others.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => {
            const into = Number(e.target.value)
            if (into) onMerge(into)
            onClose()
          }}
          className="mt-1 w-full rounded border border-stone-200 px-2 py-1 text-xs text-stone-600"
        >
          <option value="">Same person as…</option>
          {others.map((o) => (
            <option key={o.identityId} value={o.identityId ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {entry.name !== null && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            onRename('')
            onClose()
          }}
          className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-stone-500 hover:bg-stone-100"
        >
          Reset to default
        </button>
      )}
    </div>
  )
}

function TranscriptPanel({
  finals,
  interim,
  speakers,
  onRename,
  onSetMe,
  onMerge,
  onSuggest,
  onAccept
}: {
  finals: Bubble[]
  interim: Partial<Record<Channel, Bubble>>
  speakers: SpeakerIdentity[]
  onRename?: (channel: Channel, speaker: number | null, name: string) => void
  onSetMe?: (channel: Channel, speaker: number | null) => void
  onMerge?: (fromIdentityId: number, intoIdentityId: number) => void
  onSuggest?: () => Promise<{ ok: boolean; error?: string; suggestions?: SpeakerSuggestion[] }>
  onAccept?: (channel: Channel, speaker: number, name: string) => void
}): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Proposals are held here, never written, until the user accepts one.
  const [suggestions, setSuggestions] = useState<SpeakerSuggestion[] | null>(null)
  const [suggestState, setSuggestState] = useState<'idle' | 'loading' | string>('idle')

  const runSuggest = async (): Promise<void> => {
    if (!onSuggest) return
    setSuggestState('loading')
    const res = await onSuggest()
    if (!res.ok) {
      setSuggestState(res.error ?? 'Could not identify speakers')
      return
    }
    setSuggestState('idle')
    setSuggestions(res.suggestions ?? [])
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [finals.length, interim.mic?.text, interim.system?.text])

  const empty = finals.length === 0 && !interim.mic && !interim.system

  const byKey = useMemo(
    () => new Map(speakers.map((s) => [speakerKey(s.channel, s.speaker), s])),
    [speakers]
  )

  // Once the user names a note-taker, the "an undiarized mic voice is the user"
  // default must stop applying, or a hybrid note could right-align two voices.
  const anyIsMe = useMemo(() => speakers.some((s) => s.isMe), [speakers])

  const resolve = useMemo(() => {
    return (b: Bubble): Resolved => {
      const identity = byKey.get(speakerKey(b.channel, b.speaker))
      return {
        label: identity?.label ?? defaultSpeakerLabel(b.channel, b.speaker),
        identity,
        // speakerRoster() derives from the transcript with a LEFT JOIN, so EVERY
        // voice has a row and `identity` is never undefined for a note that has
        // been loaded — `identity?.isMe ?? fallback` would therefore never reach
        // its fallback, and every existing note would lose its right-aligned
        // amber "Me". The stored flag only wins when someone actually set it.
        isMe: identity?.isMe || (b.channel === 'mic' && b.speaker === undefined && !anyIsMe),
        colorIndex: paletteIndex(identity)
      }
    }
  }, [byKey, anyIsMe])

  // Alternating bubbles need two sides and few voices. A lecture has neither:
  // every bubble is mic, so it would render as one unlabelled right-aligned
  // column — the exact symptom this whole change exists to fix. Derived rather
  // than tied to the note's audio source, so a mis-set source still renders
  // correctly; the strip offers a manual override.
  const [override, setOverride] = useState<Layout | null>(null)
  const derived: Layout = useMemo(() => {
    const keys = new Set<string>()
    let hasSystem = false
    for (const b of finals) {
      keys.add(speakerKey(b.channel, b.speaker))
      if (b.channel === 'system') hasSystem = true
    }
    return hasSystem && keys.size <= CONVERSATION_MAX_SPEAKERS ? 'conversation' : 'document'
  }, [finals])
  const layout = override ?? derived

  // Caption a bubble only when its speaker differs from the previous one, so a
  // long run by one person is not labelled on every line. Computed over finals
  // AND the live interims, so a speaker change during a recording is announced
  // immediately rather than when the final lands seconds later. One forward
  // pass, so a long run does not degrade toward O(n²).
  const rows = useMemo(() => {
    const live = [interim.system, interim.mic].filter((b): b is Bubble => !!b)
    const all = [...finals.map((b) => ({ b, live: false })), ...live.map((b) => ({ b, live: true }))]
    let lastKey: string | null = null
    return all.map(({ b, live: isLive }) => {
      const key = speakerKey(b.channel, b.speaker)
      const showLabel = key !== lastKey
      lastKey = key
      return { bubble: b, isLive, showLabel, resolved: resolve(b) }
    })
  }, [finals, interim.mic, interim.system, resolve])

  const namable = speakers.filter((s) => onRename !== undefined)

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-3">
      {namable.length > 0 ? (
        <div className="mb-2 flex items-center gap-1 overflow-x-auto pb-1">
          {speakers.map((s) => {
            const key = speakerKey(s.channel, s.speaker)
            return (
              <div key={key} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setOpenKey(openKey === key ? null : key)}
                  className="flex items-center gap-1.5 rounded-full border border-stone-200 px-2 py-0.5 text-[11px] text-stone-600 hover:border-stone-300 hover:bg-stone-50"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      s.isMe ? 'bg-amber-400' : SPEAKER_DOT[paletteIndex(s)]
                    }`}
                  />
                  <span className={s.name ? 'font-medium' : ''}>{s.label}</span>
                  <span className="text-stone-400">{formatTalkTime(s.talkMs)}</span>
                </button>
                {openKey === key && (
                  <SpeakerPopover
                    entry={s}
                    others={speakers.filter(
                      (o) => o.identityId !== null && o.identityId !== s.identityId
                    )}
                    onRename={(name) => onRename?.(s.channel, s.speaker, name)}
                    onSetMe={() => onSetMe?.(s.channel, s.speaker)}
                    onMerge={(into) =>
                      s.identityId !== null && onMerge?.(s.identityId, into)
                    }
                    onClose={() => setOpenKey(null)}
                  />
                )}
              </div>
            )
          })}
          {onSuggest && (
            <button
              type="button"
              onClick={() => void runSuggest()}
              disabled={suggestState === 'loading'}
              title="Ask Claude to name these voices from the transcript's own introductions"
              className="ml-auto shrink-0 rounded border border-stone-200 px-1.5 py-0.5 text-[11px] text-stone-500 hover:bg-stone-50 disabled:opacity-50"
            >
              {suggestState === 'loading' ? 'Identifying…' : 'Identify'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOverride(layout === 'conversation' ? 'document' : 'conversation')}
            title="Switch between chat bubbles and a transcript document"
            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] text-stone-400 hover:bg-stone-100 ${
              onSuggest ? '' : 'ml-auto'
            }`}
          >
            {layout === 'conversation' ? '☰' : '⇋'}
          </button>
        </div>
      ) : (
        layout === 'conversation' && (
          <div className="mb-2 flex items-center justify-between text-xs text-stone-400">
            <span>Them</span>
            <span>Me</span>
          </div>
        )
      )}
      {typeof suggestState === 'string' && suggestState !== 'idle' && suggestState !== 'loading' && (
        <p className="mb-2 text-[11px] text-red-600">{suggestState}</p>
      )}
      {suggestions !== null && (
        <div className="mb-2 rounded-md border border-stone-200 bg-stone-50 p-2">
          {suggestions.length === 0 ? (
            <p className="text-[11px] text-stone-500">
              Nobody is named in this transcript — no one introduced themselves or was addressed by
              name.
            </p>
          ) : (
            <>
              <p className="mb-1 text-[11px] text-stone-500">
                Proposed from the transcript. Nothing is saved until you accept it.
              </p>
              {suggestions.map((sg) => (
                <div
                  key={speakerKey(sg.channel, sg.speaker)}
                  className="flex items-baseline gap-2 py-0.5"
                >
                  <span className="w-28 shrink-0 truncate text-[11px] text-stone-400">
                    {byKey.get(speakerKey(sg.channel, sg.speaker))?.label ??
                      defaultSpeakerLabel(sg.channel, sg.speaker)}
                  </span>
                  <span className="text-xs font-medium text-stone-700">{sg.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-stone-400" title={sg.reason}>
                    {sg.reason}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onAccept?.(sg.channel, sg.speaker, sg.name)
                      setSuggestions((prev) =>
                        (prev ?? []).filter(
                          (p) =>
                            speakerKey(p.channel, p.speaker) !== speakerKey(sg.channel, sg.speaker)
                        )
                      )
                    }}
                    className="shrink-0 rounded bg-stone-800 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-stone-900"
                  >
                    Use
                  </button>
                </div>
              ))}
            </>
          )}
          <button
            type="button"
            onClick={() => setSuggestions(null)}
            className="mt-1 text-[10px] text-stone-400 hover:text-stone-600"
          >
            Dismiss
          </button>
        </div>
      )}
      {empty && (
        <p className="mt-8 text-center text-sm text-stone-400">
          Transcript will appear here while recording.
        </p>
      )}
      <div className={layout === 'document' ? 'space-y-0.5' : 'space-y-1.5'}>
        {rows.map((r, i) => (
          <BubbleRow
            key={`${r.bubble.startMs}-${i}`}
            bubble={r.bubble}
            resolved={r.resolved}
            layout={layout}
            isInterim={r.isLive}
            showLabel={r.showLabel}
          />
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}

export default memo(TranscriptPanel)
