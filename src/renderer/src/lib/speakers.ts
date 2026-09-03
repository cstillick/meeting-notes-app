// MIRROR of speakerKey/defaultSpeakerLabel in src/main/enhance/prompt.ts.
//
// The duplication is deliberate and load-bearing. prompt.ts must stay importable
// by the MCP server, which Claude Desktop spawns as plain `node` with no path
// alias and no bundler — so it can only ever TYPE-import from @shared, never
// import a value module. The renderer cannot import from src/main either. One
// of the two has to hold the copy.
//
// scripts/stress/speaker-roster.ts asserts the two agree for every shape;
// do not edit one without the other.
import type { Channel, SpeakerIdentity } from '@shared/types'

/** Identity key for one voice. -1 is the undiarized sentinel. */
export function speakerKey(channel: Channel, speaker: number | null | undefined): string {
  return `${channel}:${speaker ?? -1}`
}

/** The label for a voice nobody has named. A diarized mic speaker is suffixed
 *  because mic and system are independent numbering namespaces — mic 0 and
 *  system 0 are different people, and a hybrid note shows both. */
export function defaultSpeakerLabel(
  channel: Channel,
  speaker: number | null | undefined
): string {
  if (speaker === null || speaker === undefined) return channel === 'mic' ? 'Me' : 'Them'
  return channel === 'mic' ? `Speaker ${speaker + 1} (room)` : `Speaker ${speaker + 1}`
}

/** Distinct bubble colors, wrapping past the last. Sized to match
 *  SPEAKER_PALETTE_SIZE in src/main/db/speakers.ts, which assigns the indices. */
export const SPEAKER_PALETTE = [
  'bg-stone-200 text-stone-800',
  'bg-sky-100 text-sky-950',
  'bg-emerald-100 text-emerald-950',
  'bg-violet-100 text-violet-950',
  'bg-rose-100 text-rose-950',
  'bg-cyan-100 text-cyan-950',
  'bg-lime-100 text-lime-950',
  'bg-fuchsia-100 text-fuchsia-950'
]

/** Rail colors for the document layout — the same hues as a solid bubble,
 *  applied as a left border instead of a fill. */
export const SPEAKER_RAIL = [
  'border-stone-400',
  'border-sky-400',
  'border-emerald-400',
  'border-violet-400',
  'border-rose-400',
  'border-cyan-400',
  'border-lime-400',
  'border-fuchsia-400'
]

/** Dot colors for the roster strip. */
export const SPEAKER_DOT = [
  'bg-stone-400',
  'bg-sky-400',
  'bg-emerald-400',
  'bg-violet-400',
  'bg-rose-400',
  'bg-cyan-400',
  'bg-lime-400',
  'bg-fuchsia-400'
]

/** Index a roster entry into the palettes above. */
export function paletteIndex(identity: SpeakerIdentity | undefined, fallback = 0): number {
  return ((identity?.colorIndex ?? fallback) % SPEAKER_PALETTE.length + SPEAKER_PALETTE.length) %
    SPEAKER_PALETTE.length
}

/** "12m" / "1m 20s" / "45s" — talk time on a roster chip. */
export function formatTalkTime(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}
