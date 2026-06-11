// Minimal structural shape shared by TranscriptSegment (speaker: number | null)
// and ChatLiveFinal (speaker?: number) so chat can format either source.
export interface TranscriptLine {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  speaker?: number | null
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
        const text = collectText(n)
        if (text.trim()) lines.push(`${'  '.repeat(depth)}- ${text}`)
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

export function buildUserMessage(args: {
  title: string
  startedAt: number | null
  notesJson: string
  segments: TranscriptLine[]
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

  const roughNotes = pmToPlainText(args.notesJson) || '(no notes typed)'

  const transcript = formatTranscript(args.segments) || '(no transcript)'

  return `Meeting: ${args.title || 'Untitled meeting'}
When: ${when}

<rough_notes>
${roughNotes}
</rough_notes>

<transcript>
${transcript}
</transcript>`
}
