import type { ChatLiveFinal, Meeting, MeetingSummary } from '@shared/types'
import { formatTranscript, pmToPlainText, type TranscriptLine } from '../enhance/prompt'
import { getDb } from '../db/database'
import { listMeetings, listMeetingsInFolder } from '../db/meetings'
import { searchMeetingIdsForChat } from '../db/search'
import { searchChunks, type ChunkHit } from '../embeddings/embedder'
import { rrfMerge } from '../embeddings/lib'

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

export const CHAT_FOLDER_SYSTEM = `You are an assistant for one folder of the user's meeting notes. The user's message names the folder and contains ONLY notes from that folder — answer using only those excerpts, and treat notes outside this folder as out of scope.
- Answer directly and concisely in Markdown. Lead with the answer. Use bullets for lists and bold for key facts, dates, and numbers.
- When your answer draws on a meeting, name it inline, e.g. (Design sync — Jun 3).
- A full index of the folder's meetings (title and date only) is also provided. If the excerpts don't contain the answer but the index suggests a likely meeting in this folder, say which one probably has it and suggest opening it. Never invent content, and never reference meetings outside this folder.`

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

// Context-window guard for the per-meeting path. All selectable models have a
// 200K-token window; at a conservative ~3.5 chars/token, 500K chars ≈ 143K
// tokens, leaving ample room for the system prompt, 40 turns of history, and
// the answer. Without this, a marathon recording 400s the API with
// "prompt too long" instead of degrading.
const MAX_MEETING_CONTEXT_CHARS = 500_000
const MAX_NOTES_CHARS = 150_000
const MAX_ENHANCED_CHARS = 100_000
/** Per-line formatting overhead: "[m:ss] [Speaker N] " + newline. */
const TRANSCRIPT_LINE_OVERHEAD = 24

/** Newest transcript lines that fit the budget. Trimming drops the oldest
 *  lines first: "what did they just say" questions outnumber ones about a
 *  9-hour-old opening remark, and live chat always concerns the tail. */
function fitTranscript(lines: TranscriptLine[], budget: number): { text: string; note: string } {
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

/** Per-meeting context — sent as a second (cacheable) system block. */
export function buildMeetingContext(args: {
  meeting: Meeting
  segments: TranscriptLine[]
  liveFinals?: ChatLiveFinal[]
}): string {
  const { meeting } = args
  const lines = args.liveFinals ?? args.segments
  const notes = pmToPlainText(meeting.notesJson).slice(0, MAX_NOTES_CHARS)
  const enhanced = (meeting.enhancedMd ?? '').slice(0, MAX_ENHANCED_CHARS)
  const transcript = fitTranscript(
    lines,
    MAX_MEETING_CONTEXT_CHARS - notes.length - enhanced.length
  )
  return `Meeting: ${meeting.title || 'Untitled meeting'}
When: ${formatWhen(meeting.startedAt ?? meeting.createdAt)}
Status: ${meeting.status === 'recording' ? 'IN PROGRESS (live)' : 'ended'}

<rough_notes>
${notes || '(none)'}
</rough_notes>

<enhanced_notes>
${enhanced || '(not generated yet)'}
</enhanced_notes>

<transcript>
${transcript.note}${transcript.text || '(no transcript yet)'}
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

/** Chunks the vector search surfaced for one note, in document order, capped.
 *  Beats the head-of-note excerpt: the relevant passage may live anywhere. */
function chunkExcerpt(hits: ChunkHit[]): string {
  const ordered = [...hits].sort((a, b) => a.seq - b.seq)
  const parts: string[] = []
  let total = 0
  for (const h of ordered) {
    if (total + h.text.length > MAX_EXCERPT_CHARS) break
    total += h.text.length
    parts.push(h.text)
  }
  return parts.join('\n[…]\n')
}

const VECTOR_TOP_K = 24

/** Retrieval context over a set of notes, prepended to the user turn. Hybrid:
 *  BM25 keyword rank (exact names, jargon) fused with vector-chunk rank
 *  (paraphrase, semantics) via RRF, plus recent notes and a full index of the
 *  set so the model can redirect to notes whose excerpts weren't included. The
 *  candidate set (`all`) is the only scope the model ever sees — passing a
 *  folder's notes here is what keeps folder chat from leaking other folders. */
async function buildLibraryContext(
  question: string,
  all: MeetingSummary[],
  header: string,
  folderId: string | null
): Promise<string> {
  const allowed = new Set(all.map((m) => m.id))
  const index = all
    .map((m) => `- ${m.title || 'Untitled meeting'} — ${shortDate(m.createdAt)} (${m.status})`)
    .join('\n')

  // FTS ranks across every note; restrict to the allowed set before fusing.
  const bm25Ids = searchMeetingIdsForChat(question).filter((id) => allowed.has(id))
  // [] when no Voyage key is set or the API fails — keyword-only then.
  const chunkHits = (await searchChunks(question, folderId, VECTOR_TOP_K)).filter((h) =>
    allowed.has(h.meetingId)
  )
  const hitsByMeeting = new Map<string, ChunkHit[]>()
  for (const h of chunkHits) {
    const list = hitsByMeeting.get(h.meetingId)
    if (list) list.push(h)
    else hitsByMeeting.set(h.meetingId, [h])
  }
  // Vector ranking of meetings = order their best chunk appears in the top-k.
  const vectorIds = [...new Set(chunkHits.map((h) => h.meetingId))]

  const ranked = rrfMerge([bm25Ids, vectorIds])
  const recent = all.slice(0, RECENT_MEETINGS).map((m) => m.id)
  const selected = [...new Set([...ranked, ...recent])]

  const byId = new Map(all.map((m) => [m.id, m]))
  const excerpts: string[] = []
  let total = 0
  for (const id of selected) {
    const summary = byId.get(id)
    if (!summary) continue
    const hits = hitsByMeeting.get(id)
    const text = hits ? chunkExcerpt(hits) : meetingExcerpt(id)
    if (!text) continue
    if (total + text.length > MAX_TOTAL_CHARS) break
    total += text.length
    excerpts.push(
      `<meeting title="${(summary.title || 'Untitled meeting').replace(/"/g, "'")}" date="${shortDate(summary.createdAt)}">\n${text}\n</meeting>`
    )
  }

  return `${header}<meeting_index>
${index || '(no meetings yet)'}
</meeting_index>

<meetings>
${excerpts.join('\n') || '(no meeting content available)'}
</meetings>

Question: ${question}`
}

/** Cross-meeting context for the global thread (every note). */
export function buildGlobalContext(question: string): Promise<string> {
  return buildLibraryContext(question, listMeetings(), '', null)
}

/** Context for a folder thread — restricted to that folder's notes only. */
export function buildFolderContext(
  question: string,
  folderId: string,
  folderName: string
): Promise<string> {
  return buildLibraryContext(
    question,
    listMeetingsInFolder(folderId),
    `Folder: ${folderName || 'Untitled folder'}\n\n`,
    folderId
  )
}
