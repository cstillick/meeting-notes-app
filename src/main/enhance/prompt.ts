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

/** Per-line formatting overhead: "[m:ss] [Speaker N] " + newline. */
const TRANSCRIPT_LINE_OVERHEAD = 24

/** Newest transcript lines that fit the budget. Trimming drops the oldest
 *  lines first: "what did they just say" questions outnumber ones about a
 *  9-hour-old opening remark, and live chat always concerns the tail. */
export function fitTranscript(
  lines: TranscriptLine[],
  budget: number
): { text: string; note: string } {
  let total = 0
  let start = lines.length
  while (start > 0 && total + lines[start - 1].text.length + TRANSCRIPT_LINE_OVERHEAD <= budget) {
    total += lines[start - 1].text.length + TRANSCRIPT_LINE_OVERHEAD
    start--
  }
  if (start === 0) return { text: formatTranscript(lines), note: '' }
  return {
    text: formatTranscript(lines.slice(start)),
    note: `[Transcript trimmed to fit the context window: the earliest ${start} of ${lines.length} lines are omitted; the transcript below starts partway through the meeting.]\n`
  }
}

// Static system prompt (stable prefix — cacheable).
export const SYSTEM_PROMPT = `You are a meeting-notes editor. You will receive a meeting transcript with labeled speakers — "Me" (the note-taker) and one or more other participants labeled "Speaker 1", "Speaker 2", … (or "Them" when the voice could not be distinguished) — plus the rough notes the note-taker typed during the meeting. Speaker numbers identify distinct voices, not names; if the transcript reveals a speaker's name, you may use it when attributing statements.

Produce enhanced meeting notes in Markdown:
- Line 1: a short, descriptive meeting title as an H1 heading.
- Use the note-taker's rough notes as the backbone: keep their structure, order, and intent. Expand each of their points with relevant context, decisions, numbers, and names from the transcript.
- Preserve the note-taker's own wording wherever possible, fixing only obvious typos. Wrap every span of text that comes from the note-taker's own notes (verbatim or lightly typo-corrected) in the markers ⟦U⟧ … ⟦/U⟧. Text you add from the transcript gets no markers.
- Add sections the notes imply but don't cover (for example "Action items" or "Decisions") only when the transcript supports them.
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

export function speakerLabel(s: TranscriptLine): string {
  if (s.channel === 'mic') return 'Me'
  return s.speaker == null ? 'Them' : `Speaker ${s.speaker + 1}`
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "[m:ss] [Speaker] text" lines — the transcript format every prompt uses. */
export function formatTranscript(lines: TranscriptLine[]): string {
  return lines
    .map((s) => `[${formatTimestamp(s.startMs)}] [${speakerLabel(s)}] ${s.text}`)
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

  const transcript = fitTranscript(args.segments, Math.max(0, args.budget - roughNotes.length))

  return `Meeting: ${args.title || 'Untitled meeting'}
When: ${when}

<rough_notes>
${roughNotes}
</rough_notes>

<transcript>
${transcript.note}${transcript.text || '(no transcript)'}
</transcript>`
}
