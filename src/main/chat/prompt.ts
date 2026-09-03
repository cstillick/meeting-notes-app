import type { ChatLiveFinal, Meeting, MeetingSummary } from '@shared/types'
import {
  fitTranscript,
  MAX_NOTES_CHARS,
  pmToPlainText,
  type SpeakerNames,
  type TranscriptLine
} from '../enhance/prompt'
import { getDb } from '../db/database'
import { listMeetings, listMeetingsInFolder } from '../db/meetings'
import { searchMeetingIdsForChat } from '../db/search'
import { searchChunks, type ChunkHit } from '../embeddings/embedder'
import { rrfMerge } from '../embeddings/lib'

// Static system prompts (stable prefixes — cacheable).

export const CHAT_MEETING_SYSTEM = `You are an assistant for one recording — a meeting, a lecture, or an interview. Answer questions about it using ONLY the provided rough notes, enhanced notes, and transcript.
- Speaker labels: a name or role was assigned by the user and is authoritative. A numbered label ("Speaker 1", "Speaker 2 (room)") is a distinct voice, not a name — use a real name if the transcript reveals one, and "(room)" means that voice was in the room rather than on a call. "Me" is the note-taker's own microphone; an in-person or imported recording has no "Me" at all, so never assume the dominant speaker is the user.
- Answer directly and concisely in Markdown. Lead with the answer, then supporting detail. Use bullets for lists and bold for key facts, dates, and numbers.
- When quoting what someone said, quote the short verbatim phrase and add its timestamp, e.g. "we'll ship Friday" (12:41).
- If the answer is not in the transcript or notes, say so plainly. Never invent details or speculate beyond what was said.
- The meeting may still be in progress: the transcript simply ends at the most recent words spoken. Questions like "what did they just say" refer to the end of the transcript.`

export const CHAT_GLOBAL_SYSTEM = `You are an assistant for the user's personal library of meeting notes. Answer using ONLY the meeting excerpts provided in the user's message. Each excerpt is labeled with the meeting's title and date.
- Answer directly and concisely in Markdown. Lead with the answer. Use bullets for lists and bold for key facts, dates, and numbers.
- When your answer draws on a meeting, name it inline, e.g. (Design sync — Jun 3).
- An index of the user's meetings (title and date only) is also provided; on a large library it lists only the most recent ones and says how many are omitted. If the excerpts don't contain the answer but the index suggests a likely meeting, say which meeting probably has it and suggest opening that meeting and asking there. Never invent content for meetings whose excerpts were not provided.`

export const CHAT_FOLDER_SYSTEM = `You are an assistant for one folder of the user's meeting notes. The user's message names the folder and contains ONLY notes from that folder — answer using only those excerpts, and treat notes outside this folder as out of scope.
- Answer directly and concisely in Markdown. Lead with the answer. Use bullets for lists and bold for key facts, dates, and numbers.
- When your answer draws on a meeting, name it inline, e.g. (Design sync — Jun 3).
- An index of the folder's meetings (title and date only) is also provided; on a large folder it lists only the most recent ones and says how many are omitted. If the excerpts don't contain the answer but the index suggests a likely meeting in this folder, say which one probably has it and suggest opening it. Never invent content, and never reference meetings outside this folder.`

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

const MAX_ENHANCED_CHARS = 100_000

/** Per-meeting context — sent as a second (cacheable) system block. */
export function buildMeetingContext(args: {
  meeting: Meeting
  segments: TranscriptLine[]
  liveFinals?: ChatLiveFinal[]
  /** Chars this block may spend: the model's whole request budget minus the
   *  system prompt and the replayed history, so the transcript is trimmed
   *  against what is actually left rather than a fixed constant. */
  budget: number
  /** User-assigned speaker names. Resolved on this side from the meeting id
   *  rather than shipped per line, so a live-finals turn and a stored-rows turn
   *  cannot label the same voice differently. */
  names?: SpeakerNames
}): string {
  const { meeting, budget } = args
  const lines = args.liveFinals ?? args.segments
  const notes = pmToPlainText(meeting.notesJson).slice(0, Math.min(MAX_NOTES_CHARS, budget))
  const enhanced = (meeting.enhancedMd ?? '').slice(
    0,
    Math.max(0, Math.min(MAX_ENHANCED_CHARS, budget - notes.length))
  )
  const transcript = fitTranscript(
    lines,
    Math.max(0, budget - notes.length - enhanced.length),
    args.names
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
      .prepare('SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms, id')
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
/** Meetings listed in <meeting_index>, newest first. One line is ~45 chars, so
 *  300 lines ≈ 13K chars; uncapped, a 5,000-note library would emit ~64K tokens
 *  of index on every single turn. */
const MAX_INDEX_MEETINGS = 300

/** Retrieval context over a set of notes. Split in two so the caller can cache
 *  the stable half: `system` carries the folder name and the meeting index —
 *  identical across turns of a thread — while `userTurn` carries the volatile
 *  excerpts and the question. */
export interface LibraryContext {
  system: string
  userTurn: string
}

/** Retrieval context over a set of notes. Hybrid: BM25 keyword rank (exact
 *  names, jargon) fused with vector-chunk rank (paraphrase, semantics) via RRF,
 *  plus recent notes and an index of the set so the model can redirect to notes
 *  whose excerpts weren't included. The candidate set (`all`) is the only scope
 *  the model ever sees — passing a folder's notes here is what keeps folder
 *  chat from leaking other folders. */
async function buildLibraryContext(
  question: string,
  all: MeetingSummary[],
  header: string,
  folderId: string | null,
  budget: number
): Promise<LibraryContext> {
  const allowed = new Set(all.map((m) => m.id))

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

  // The newest N, plus everything an excerpt was built for so the model can
  // always name what it was shown. The omission count keeps it from concluding
  // a note doesn't exist just because the index stopped short.
  const listed = new Set(all.slice(0, MAX_INDEX_MEETINGS).map((m) => m.id))
  for (const id of selected) listed.add(id)
  const indexLines = all
    .filter((m) => listed.has(m.id))
    .map((m) => `- ${m.title || 'Untitled meeting'} — ${shortDate(m.createdAt)} (${m.status})`)
  const omitted = all.length - indexLines.length
  if (omitted > 0) indexLines.push(`(… and ${omitted} older notes not listed)`)
  const index = indexLines.join('\n') || '(no meetings yet)'

  const excerptBudget = Math.min(MAX_TOTAL_CHARS, Math.max(0, budget - index.length))
  const byId = new Map(all.map((m) => [m.id, m]))
  const excerpts: string[] = []
  let total = 0
  for (const id of selected) {
    const summary = byId.get(id)
    if (!summary) continue
    const text = excerptFor(id, hitsByMeeting.get(id))
    if (!text) continue
    if (total + text.length > excerptBudget) break
    total += text.length
    excerpts.push(
      `<meeting title="${(summary.title || 'Untitled meeting').replace(/"/g, "'")}" date="${shortDate(summary.createdAt)}">\n${text}\n</meeting>`
    )
  }

  return {
    system: `${header}<meeting_index>
${index}
</meeting_index>`,
    userTurn: `<meetings>
${excerpts.join('\n') || '(no meeting content available)'}
</meetings>

Question: ${question}`
  }
}

/** Vector hits first (the matched passage can live anywhere in a long note),
 *  then as much of the head-of-note excerpt as still fits. Combining rather
 *  than choosing matters because a single weak chunk hit used to *replace* up
 *  to MAX_EXCERPT_CHARS of enhanced notes — so adding a Voyage key could make
 *  the context shallower than keyword-only retrieval. */
function excerptFor(meetingId: string, hits: ChunkHit[] | undefined): string {
  const chunks = hits ? chunkExcerpt(hits) : ''
  const room = MAX_EXCERPT_CHARS - chunks.length
  const summary = room > 0 ? meetingExcerpt(meetingId).slice(0, room) : ''
  return [chunks, summary].filter(Boolean).join('\n[…]\n')
}

/** Cross-meeting context for the global thread (every note). */
export function buildGlobalContext(question: string, budget: number): Promise<LibraryContext> {
  return buildLibraryContext(question, listMeetings(), '', null, budget)
}

/** Context for a folder thread — restricted to that folder's notes only. */
export function buildFolderContext(
  question: string,
  folderId: string,
  folderName: string,
  budget: number
): Promise<LibraryContext> {
  return buildLibraryContext(
    question,
    listMeetingsInFolder(folderId),
    `Folder: ${folderName || 'Untitled folder'}\n\n`,
    folderId,
    budget
  )
}
