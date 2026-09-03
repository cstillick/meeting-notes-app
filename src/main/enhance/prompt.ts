import type { ModelOption } from '@shared/types'

// Minimal structural shape shared by TranscriptSegment (speaker: number | null)
// and ChatLiveFinal (speaker?: number) so chat can format either source.
export interface TranscriptLine {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  speaker?: number | null
}

/** Conservative chars-per-token for English prose (the real ratio is ~3.5-4,
 *  so this over-counts tokens rather than under-counting them). */
const CHARS_PER_TOKEN = 3
/** Share of the window the prompt may fill. The rest covers thinking tokens,
 *  the answer, and the error in the estimate above. */
const PROMPT_WINDOW_FRACTION = 0.6
/** Ceiling regardless of window size: a 1M-token model would swallow ~1.8M
 *  chars, but a prompt that size costs minutes and dollars on every request. */
const MAX_PROMPT_CHARS = 500_000

/** How many chars of retrieved content a request may still spend, given the
 *  selected model's window and what the fixed parts (system prompts, replayed
 *  history, meeting index) already cost. Only `claude-haiku-4-5` has a 200K
 *  window — every other offered model has 1M — so this is keyed off the model
 *  rather than a fixed constant. Without it a marathon recording 400s the API
 *  with "prompt too long" instead of degrading. */
export function promptBudget(model: ModelOption, fixedChars: number): number {
  const window = Math.floor(model.contextTokens * PROMPT_WINDOW_FRACTION * CHARS_PER_TOKEN)
  return Math.max(0, Math.min(MAX_PROMPT_CHARS, window) - fixedChars)
}

export const MAX_NOTES_CHARS = 150_000

/** Per-line formatting overhead: "[m:ss] [Speaker N] " + newline. Sized for
 *  the longest GENERATED label ("Speaker N", 9 chars); a longer user-assigned
 *  name is charged the difference on top, in fitTranscript below. */
const TRANSCRIPT_LINE_OVERHEAD = 24
/** Label length TRANSCRIPT_LINE_OVERHEAD already accounts for. */
const BUDGETED_LABEL_CHARS = 10

/** Newest transcript lines that fit the budget. Trimming drops the oldest
 *  lines first: "what did they just say" questions outnumber ones about a
 *  9-hour-old opening remark, and live chat always concerns the tail. */
export function fitTranscript(
  lines: TranscriptLine[],
  budget: number,
  names?: SpeakerNames
): { text: string; note: string } {
  // Charge each line its real rendered label: with no names the longest is
  // "Speaker N" and the extra term is 0, so the arithmetic is bit-identical to
  // what it was before names existed. A long assigned name correctly costs more.
  const overheadOf = (line: TranscriptLine): number =>
    TRANSCRIPT_LINE_OVERHEAD +
    Math.max(0, speakerLabel(line, names).length - BUDGETED_LABEL_CHARS)
  let total = 0
  let start = lines.length
  while (start > 0 && total + lines[start - 1].text.length + overheadOf(lines[start - 1]) <= budget) {
    total += lines[start - 1].text.length + overheadOf(lines[start - 1])
    start--
  }
  if (start === 0) return { text: formatTranscript(lines, names), note: '' }
  return {
    text: formatTranscript(lines.slice(start), names),
    note: `[Transcript trimmed to fit the context window: the earliest ${start} of ${lines.length} lines are omitted; the transcript below starts partway through the meeting.]\n`
  }
}

// Static system prompt (stable prefix — cacheable).
export const SYSTEM_PROMPT = `You are a notes editor for meetings, lectures and interviews. You will receive a transcript with labeled speakers, plus the rough notes the note-taker typed at the time.

How to read the speaker labels:
- A label that is a name or a role ("Dana", "Prof. Chen", "Interviewer") was assigned by the user. It is authoritative — use it, and do not re-guess who that voice is from context.
- A numbered label ("Speaker 1", "Speaker 2", "Speaker 3 (room)") identifies a distinct voice, not a name. If the transcript itself reveals whose voice it is, you may use that name when attributing statements. "(room)" means the voice was in the same room as the note-taker rather than on a call.
- "Me" is the note-taker's own microphone, and "Them" a voice that could not be distinguished. Many recordings have NO note-taker voice at all — an in-person lecture, an imported file — so do not assume the dominant speaker is the person taking the notes, and do not invent a "Me".

Produce enhanced notes in Markdown:
- Line 1: a short, descriptive meeting title as an H1 heading.
- Use the note-taker's rough notes as the backbone: keep their structure, order, and intent. Expand each of their points with relevant context, decisions, numbers, and names from the transcript.
- Preserve the note-taker's own wording wherever possible, fixing only obvious typos. Wrap every span of text that comes from the note-taker's own notes (verbatim or lightly typo-corrected) in the markers ⟦U⟧ … ⟦/U⟧. Text you add from the transcript gets no markers.
- Add sections the notes imply but don't cover (for example "Action items" or "Decisions") only when the transcript supports them.
- When one voice dominates and others interject only briefly, this is a lecture or a talk rather than a discussion: treat the dominant voice as the presenter and the brief ones as audience questions, attribute questions to the asker, and structure the notes and the outline by topic taught rather than by decisions made.
- Never invent facts that are not in the transcript or the notes. If the transcript is too sparse to expand a point, keep the point as written.
- If the rough notes are empty, summarize the meeting from the transcript alone (no ⟦U⟧ markers in that case).
- Structure with headings and bullet points. Be concise — this is a reference document, not prose.
- End the document with a final section "## Meeting outline": a nested bullet outline of the entire meeting in chronological order. Top-level bullets are the major topics; second-level bullets are subtopics, decisions, and questions within each topic; third-level bullets are supporting details (names, numbers, short quotes). Indent each nesting level by exactly 2 spaces. Use 3 levels (a 4th only when genuinely needed). Cover the whole meeting, including parts the rough notes skip. Keep each bullet under ~12 words. Do not use ⟦U⟧ markers in this section — it is built from the transcript.`

/** Extract readable plain text (with rough list structure) from ProseMirror JSON. */
export function pmToPlainText(notesJson: string): string {
  try {
    const lines: string[] = []
    const walkBlock = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object') return
      const n = node as { type?: string; text?: string; content?: unknown[] }
      if (n.type === 'paragraph' || n.type === 'heading') {
        const text = collectText(n)
        if (text.trim()) lines.push(`${'  '.repeat(depth)}${text}`)
        return
      }
      if (n.type === 'listItem' || n.type === 'taskItem') {
        const children = Array.isArray(n.content) ? n.content : []
        const isNestedList = (c: unknown): boolean => {
          const t = (c as { type?: string } | null)?.type
          return t === 'bulletList' || t === 'orderedList'
        }
        // Only this item's own text on this line; a nested list would
        // otherwise fuse into it ("first pointnested detail") and poison
        // FTS, chunks, and prompts. Nested lists walk as deeper items.
        const text = children
          .filter((c) => !isNestedList(c))
          .map(collectText)
          .join('')
        if (text.trim()) lines.push(`${'  '.repeat(depth)}- ${text}`)
        children.filter(isNestedList).forEach((c) => walkBlock(c, depth))
        return
      }
      if (Array.isArray(n.content)) {
        const nextDepth = n.type === 'bulletList' || n.type === 'orderedList' ? depth + 1 : depth
        n.content.forEach((c) => walkBlock(c, nextDepth))
      }
    }
    const collectText = (node: unknown): string => {
      const parts: string[] = []
      const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object') return
        const xn = x as { text?: string; content?: unknown[] }
        if (typeof xn.text === 'string') parts.push(xn.text)
        if (Array.isArray(xn.content)) xn.content.forEach(walk)
      }
      walk(node)
      return parts.join('')
    }
    walkBlock(JSON.parse(notesJson), 0)
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** Per-note display names keyed by speakerKey(). An absent map — or an absent
 *  key within it — falls back to the generated label, which is byte-identical
 *  to what this file produced before names existed. Every consumer passes the
 *  map optionally, so a note with no assigned names renders exactly as before. */
export type SpeakerNames = ReadonlyMap<string, string>

/** Identity key for one diarized voice. -1 is the undiarized sentinel — the
 *  same one idx_segments_unique already coalesces a NULL speaker to — which is
 *  what makes "Me" and "Them" nameable on notes recorded before diarization. */
export function speakerKey(
  channel: 'mic' | 'system',
  speaker: number | null | undefined
): string {
  return `${channel}:${speaker ?? -1}`
}

/** The generated label for a key with no user-assigned name. A diarized MIC
 *  speaker is suffixed because the two channels are independent diarization
 *  namespaces — mic speaker 0 and system speaker 0 are different people — and
 *  a hybrid note renders both at once. The mic-null and system branches are
 *  unchanged from the original implementation and must stay so: chunk text,
 *  MCP output and every export are pinned to them by scripts/stress. */
export function defaultSpeakerLabel(
  channel: 'mic' | 'system',
  speaker: number | null | undefined
): string {
  if (speaker === null || speaker === undefined) return channel === 'mic' ? 'Me' : 'Them'
  return channel === 'mic' ? `Speaker ${speaker + 1} (room)` : `Speaker ${speaker + 1}`
}

export function speakerLabel(s: TranscriptLine, names?: SpeakerNames): string {
  return names?.get(speakerKey(s.channel, s.speaker)) ?? defaultSpeakerLabel(s.channel, s.speaker)
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "[m:ss] [Speaker] text" lines — the transcript format every prompt uses. */
export function formatTranscript(lines: TranscriptLine[], names?: SpeakerNames): string {
  return lines
    .map((s) => `[${formatTimestamp(s.startMs)}] [${speakerLabel(s, names)}] ${s.text}`)
    .join('\n')
}

/** Appended to a first-time enhancement that hit `stop_reason: 'max_tokens'`,
 *  so the saved document says so rather than just ending mid-sentence. */
export const TRUNCATION_NOTE =
  '_[Enhancement cut off — the model hit its output limit before finishing. Re-run to try again.]_'

export function buildUserMessage(args: {
  title: string
  startedAt: number | null
  notesJson: string
  segments: TranscriptLine[]
  /** Chars the notes + transcript may fill. The oldest transcript lines are
   *  dropped first when the meeting outgrows the selected model's window. */
  budget: number
  /** User-assigned speaker names; absent = generated labels, as before. */
  names?: SpeakerNames
}): string {
  const when = args.startedAt
    ? new Date(args.startedAt).toLocaleString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : 'unknown time'

  const roughNotes =
    pmToPlainText(args.notesJson).slice(0, Math.min(MAX_NOTES_CHARS, args.budget)) ||
    '(no notes typed)'

  const transcript = fitTranscript(
    args.segments,
    Math.max(0, args.budget - roughNotes.length),
    args.names
  )

  return `Meeting: ${args.title || 'Untitled meeting'}
When: ${when}

<rough_notes>
${roughNotes}
</rough_notes>

<transcript>
${transcript.note}${transcript.text || '(no transcript)'}
</transcript>`
}
