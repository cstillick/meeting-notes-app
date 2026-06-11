import type { ChatLiveFinal, Meeting } from '@shared/types'
import { formatTranscript, pmToPlainText, type TranscriptLine } from '../enhance/prompt'
import { getDb } from '../db/database'
import { listMeetings } from '../db/meetings'
import { searchMeetingIdsForChat } from '../db/search'

// Static system prompts (stable prefixes — cacheable).

export const CHAT_MEETING_SYSTEM = `You are a meeting assistant. Answer questions about the meeting described in the context block using ONLY the provided rough notes, enhanced notes, and transcript. "Me" is the note-taker; "Speaker 1", "Speaker 2", … (or "Them" when the voice could not be distinguished) are other participants — use real names when the transcript reveals them.
- Answer directly and concisely in Markdown. Lead with the answer, then supporting detail. Use bullets for lists and bold for key facts, dates, and numbers.
- When quoting what someone said, quote the short verbatim phrase and add its timestamp, e.g. "we'll ship Friday" (12:41).
- If the answer is not in the transcript or notes, say so plainly. Never invent details or speculate beyond what was said.
- The meeting may still be in progress: the transcript simply ends at the most recent words spoken. Questions like "what did they just say" refer to the end of the transcript.`

export const CHAT_GLOBAL_SYSTEM = `You are an assistant for the user's personal library of meeting notes. Answer using ONLY the meeting excerpts provided in the user's message. Each excerpt is labeled with the meeting's title and date.
- Answer directly and concisely in Markdown. Lead with the answer. Use bullets for lists and bold for key facts, dates, and numbers.
- When your answer draws on a meeting, name it inline, e.g. (Design sync — Jun 3).
- A full index of every meeting (title and date only) is also provided. If the excerpts don't contain the answer but the index suggests a likely meeting, say which meeting probably has it and suggest opening that meeting and asking there. Never invent content for meetings whose excerpts were not provided.`

function formatWhen(ts: number | null): string {
  if (!ts) return 'unknown time'
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Per-meeting context — sent as a second (cacheable) system block. */
export function buildMeetingContext(args: {
  meeting: Meeting
  segments: TranscriptLine[]
  liveFinals?: ChatLiveFinal[]
}): string {
  const { meeting } = args
  const lines = args.liveFinals ?? args.segments
  return `Meeting: ${meeting.title || 'Untitled meeting'}
When: ${formatWhen(meeting.startedAt ?? meeting.createdAt)}
Status: ${meeting.status === 'recording' ? 'IN PROGRESS (live)' : 'ended'}

<rough_notes>
${pmToPlainText(meeting.notesJson) || '(none)'}
</rough_notes>

<enhanced_notes>
${meeting.enhancedMd || '(not generated yet)'}
</enhanced_notes>

<transcript>
${formatTranscript(lines) || '(no transcript yet)'}
</transcript>`
}

const MAX_EXCERPT_CHARS = 8_000
const MAX_TOTAL_CHARS = 60_000
const RECENT_MEETINGS = 5

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Best available text for a meeting: enhanced notes, else rough notes, else transcript. */
function meetingExcerpt(meetingId: string): string {
  const db = getDb()
  const row = db
    .prepare('SELECT notes_json, enhanced_md FROM meetings WHERE id = ?')
    .get(meetingId) as { notes_json: string; enhanced_md: string | null } | undefined
  if (!row) return ''
  if (row.enhanced_md) return row.enhanced_md.slice(0, MAX_EXCERPT_CHARS)
  const notes = pmToPlainText(row.notes_json)
  const transcript = (
    db
      .prepare('SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms')
      .all(meetingId) as unknown as { text: string }[]
  )
    .map((r) => r.text)
    .join(' ')
  return [notes, transcript].filter(Boolean).join('\n\n').slice(0, MAX_EXCERPT_CHARS)
}

/** Cross-meeting context for the global thread, prepended to the user turn:
 *  FTS-ranked matches for the question + recent meetings, plus a full index
 *  so the model can redirect to meetings whose excerpts weren't included. */
export function buildGlobalContext(question: string): string {
  const all = listMeetings()
  const index = all
    .map((m) => `- ${m.title || 'Untitled meeting'} — ${shortDate(m.createdAt)} (${m.status})`)
    .join('\n')

  const matched = searchMeetingIdsForChat(question)
  const recent = all.slice(0, RECENT_MEETINGS).map((m) => m.id)
  const selected = [...new Set([...matched, ...recent])]

  const byId = new Map(all.map((m) => [m.id, m]))
  const excerpts: string[] = []
  let total = 0
  for (const id of selected) {
    const summary = byId.get(id)
    if (!summary) continue
    const text = meetingExcerpt(id)
    if (!text) continue
    if (total + text.length > MAX_TOTAL_CHARS) break
    total += text.length
    excerpts.push(
      `<meeting title="${(summary.title || 'Untitled meeting').replace(/"/g, "'")}" date="${shortDate(summary.createdAt)}">\n${text}\n</meeting>`
    )
  }

  return `<meeting_index>
${index || '(no meetings yet)'}
</meeting_index>

<meetings>
${excerpts.join('\n') || '(no meeting content available)'}
</meetings>

Question: ${question}`
}
