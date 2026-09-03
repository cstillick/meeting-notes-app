// Tool bodies for the MCP server: Library + validated args in, model-facing
// text out. Kept free of MCP types so the stress suite can call them directly
// without standing up a transport.
//
// Formatting is borrowed from the app's own prompt builder — the transcript a
// model sees through MCP is byte-for-byte the transcript the in-app chat sees.
// prompt.ts imports only types from @shared, so it carries no Electron with it.
import {
  formatTimestamp,
  pmToPlainText,
  speakerLabel,
  type SpeakerNames,
  type TranscriptLine
} from '../main/enhance/prompt.ts'
import { appendMarkdownToDoc, markdownToPmDoc } from './pm.ts'
import { appRequest } from './appControl.ts'
import {
  consumeConfirmToken,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  issueConfirmToken,
  renameFolder,
  updateNote
} from './writes.ts'
import {
  countSegments,
  findNoteIdsByPrefix,
  findNotesByTitle,
  getNote,
  getSegments,
  listFolderNames,
  listFoldersWithCounts,
  listNotes,
  outlineNotes,
  overview,
  topicGroups,
  resolveFolder,
  searchNotes,
  searchTranscript,
  speakerNames,
  entitiesForNote,
  graphEntities,
  hasGraph,
  relatedNotesFor,
  type Library,
  type NoteContent,
  type NoteMeta,
  type ResolvedFolder,
  type SegmentRow
} from './db.ts'

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function when(ts: number | null): string {
  if (!ts) return 'unknown time'
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** How long the meeting ran, from whichever of the two records is longer.
 *
 *  started_at/ended_at are wall-clock stamps the recorder writes, and they are
 *  not always trustworthy: re-recording an existing note overwrites started_at
 *  with the later session's time while the transcript keeps appending on the
 *  original timeline, which leaves the clock claiming seconds for a meeting
 *  whose transcript covers half an hour. Three notes in the author's own
 *  library are in exactly that state. The transcript's furthest end_ms is
 *  derived from the audio itself, so taking the maximum reports a duration
 *  that is never shorter than what was demonstrably recorded. */
function duration(n: NoteMeta): string | null {
  const clockMs =
    n.startedAt !== null && n.endedAt !== null ? Math.max(0, n.endedAt - n.startedAt) : 0
  const ms = Math.max(clockMs, n.transcriptMs)
  if (ms < 30_000) return null
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

/** One-line note header. Every listing uses it so ids always travel with the
 *  content a model is reading — the follow-up call needs the id, not the title. */
function noteHeader(n: NoteMeta): string {
  const facts = [when(n.createdAt)]
  const d = duration(n)
  if (d) facts.push(d)
  if (n.folderName) facts.push(`folder: ${n.folderName}`)
  facts.push(n.status)
  if (n.segmentCount > 0) facts.push(`${n.segmentCount} transcript lines`)
  else facts.push('no transcript')
  // status 'enhanced' already says this; only notes that carry enhanced text
  // under some other status need calling out.
  if (n.hasEnhanced && n.status !== 'enhanced') facts.push('enhanced notes available')
  return `**${n.title || 'Untitled note'}**\n  id: ${n.id}\n  ${facts.join(' · ')}`
}

/** The enhancer wraps the user's own words in ⟦U⟧…⟦/U⟧ so the editor can render
 *  them black; a tenth of the stored documents still carry the markers. They
 *  mean nothing outside the app, so they never reach a model. */
function stripSentinels(md: string): string {
  // Not two literal replacements: a model that half-emits a marker leaves
  // things like ⟦/U⟦ or a bare ⟧ behind, and 23 of the author's 102 enhanced
  // notes carry such residue. Match either bracket in either position, then
  // sweep any stray bracket that survives.
  return md.replace(/[⟦⟧]\/?U[⟦⟧]/g, '').replace(/[⟦⟧]/g, '')
}

/** Human description of an active scope, shared by the listing and search
 *  tools so a zero-result message can say what excluded the results. */
function scopeLabel(args: {
  folder?: ResolvedFolder | null
  status?: string
  after?: string
  before?: string
  titleContains?: string
  titleStartsWith?: string
}): string {
  return [
    args.folder
      ? args.folder.kind === 'unfiled'
        ? 'in no folder'
        : `in folder "${args.folder.name}"`
      : '',
    args.titleStartsWith ? `whose title starts with "${args.titleStartsWith}"` : '',
    args.titleContains ? `with "${args.titleContains}" in the title` : '',
    args.status ? `with status ${args.status}` : '',
    args.after ? `after ${args.after}` : '',
    args.before ? `before ${args.before}` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

function clip(text: string, max: number): { text: string; clipped: number } {
  if (text.length <= max) return { text, clipped: 0 }
  return { text: text.slice(0, max), clipped: text.length - max }
}

/** "[m:ss] [Speaker] text" — the same shape the app's own prompts use, so a
 *  transcript read through MCP and one read by the in-app chat are identical. */
function transcriptLine(r: SegmentRow, names?: SpeakerNames): string {
  const line: TranscriptLine = {
    channel: r.channel,
    text: r.text,
    startMs: r.startMs,
    speaker: r.speaker
  }
  return `[${formatTimestamp(r.startMs)}] [${speakerLabel(line, names)}] ${r.text}`
}

function transcriptLines(rows: SegmentRow[], names?: SpeakerNames): string {
  return rows.map((r) => transcriptLine(r, names)).join('\n')
}

/** One line naming who is in a note, so the model knows which labels are real
 *  identities the user vouched for and which are just distinct voices. Replaces
 *  the old fixed claim that "Me" is the user and everyone else is remote —
 *  false for an in-person recording and for every imported file. */
function speakerPreamble(labels: string[]): string {
  if (labels.length === 0) return ''
  return (
    `Speakers: ${labels.join(', ')}. ` +
    'Named speakers were identified by the user and are authoritative. ' +
    'Numbered ones are distinct voices, not names. ' +
    '"Me" is the note-taker\'s own microphone, and is absent from recordings ' +
    'with no note-taker voice, such as imported files and in-person captures.'
  )
}

/** The distinct resolved labels in one note, in first-appearance order. */
function noteSpeakerLabels(rows: SegmentRow[], names?: SpeakerNames): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const label = speakerLabel(
      { channel: r.channel, text: r.text, startMs: r.startMs, speaker: r.speaker },
      names
    )
    if (!seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out
}

/** Date bounds arrive as YYYY-MM-DD or a full ISO stamp. A bare date means the
 *  user's local day, not UTC midnight — otherwise "after 2026-06-03" silently
 *  drops the evening of June 2nd for anyone west of Greenwich. */
function parseDate(value: string, label: string): number {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
  const ms = new Date(bare ? `${value.trim()}T00:00:00` : value).getTime()
  if (Number.isNaN(ms)) {
    throw new Error(`${label}: "${value}" is not a date. Use YYYY-MM-DD or a full ISO timestamp.`)
  }
  return ms
}

/** `before` is exclusive, so a bare date has to mean "through the end of that
 *  day" or `before: 2026-06-03` would exclude everything recorded on June 3rd. */
function parseBefore(value: string): number {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
  const ms = parseDate(value, 'before')
  return bare ? ms + 86_400_000 : ms
}

export interface DateArgs {
  after?: string
  before?: string
}

function dateBounds(a: DateArgs): { afterMs?: number; beforeMs?: number } {
  return {
    afterMs: a.after === undefined ? undefined : parseDate(a.after, 'after'),
    beforeMs: a.before === undefined ? undefined : parseBefore(a.before)
  }
}

/** Folder references that name nothing are an error, not an empty result: a
 *  model that guessed the wrong folder name should be told the real ones
 *  instead of concluding the folder is empty. */
function folderRef(lib: Library, folder: string | undefined): ResolvedFolder | null {
  // Only an absent argument means "no filter". A blank string is a caller
  // mistake, and silently searching everything is the wrong answer to it —
  // resolveFolder will reject it with the list of real folders.
  if (folder === undefined) return null
  const resolved = resolveFolder(lib, folder)
  if (resolved) return resolved
  const names = listFolderNames(lib)
  throw new Error(
    `No folder matching "${folder}". Existing folders: ${
      names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)'
    }. Use "unfiled" for notes that are in no folder.`
  )
}

/** Accept the full id or an unambiguous prefix; otherwise fail with real
 *  candidates rather than a bare "not found". */
function requireNote(lib: Library, ref: string): NoteContent {
  const trimmed = ref.trim()
  if (trimmed === '') {
    throw new Error('note_id is empty. Use search_notes or list_notes to find one.')
  }
  const exact = getNote(lib, ref)
  if (exact) return exact
  // 3, not 6: the schema advertises that a prefix works, and the first block of
  // a uuid is 8 characters — but a model that echoes only the first few was
  // being told the note does not exist.
  if (trimmed.length >= 3) {
    const prefixed = findNoteIdsByPrefix(lib, trimmed)
    if (prefixed.length === 1) return getNote(lib, prefixed[0])!
    if (prefixed.length > 1) {
      throw new Error(`"${ref}" matches ${prefixed.length} notes. Use the full id.`)
    }
  }
  const byTitle = findNotesByTitle(lib, trimmed)
  const hint = byTitle.length
    ? ` Notes with a matching title:\n${byTitle.map((n) => noteHeader(n)).join('\n')}`
    : ' Use search_notes or list_notes to find the id.'
  throw new Error(`No note with id "${ref}".${hint}`)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function libraryOverview(lib: Library): string {
  const o = overview(lib)
  if (o.notes === 0) return 'The library is empty — no notes have been created yet.'
  const hours = o.recordedMs / 3_600_000
  const lines = [
    `**Notetaker library** (${lib.path})`,
    ``,
    `- ${o.notes} notes, ${o.enhanced} with AI-enhanced notes`,
    `- ${o.withTranscript} notes have a transcript (${o.segments.toLocaleString()} spoken lines, ~${hours.toFixed(1)} hours recorded)`,
    `- ${o.folders} folders`,
    `- Oldest note: ${when(o.oldest)}`,
    `- Newest note: ${when(o.newest)}`,
    `- Status breakdown: ${o.byStatus.map((s) => `${s.status} ${s.n}`).join(', ')}`,
    ``,
    `Search with search_notes (notes + transcripts, ranked) or search_transcript (exact spoken words with timestamps).`
  ]
  return lines.join('\n')
}

export function listFoldersTool(lib: Library): string {
  const { folders, unfiled } = listFoldersWithCounts(lib)
  if (folders.length === 0) {
    return `No folders. All ${unfiled} notes are unfiled.`
  }
  const rows = folders.map((f) => `- **${f.name}** — ${f.noteCount} notes\n  id: ${f.id}`)
  rows.push(`- **(unfiled)** — ${unfiled} notes`)
  return `${folders.length} folders:\n\n${rows.join('\n')}\n\nPass a folder name to list_notes, search_notes, or search_transcript to scope to it.`
}

/** Short id length used in the outline. Full uuids would be over a third of
 *  the payload for a large folder; 8 hex characters is unambiguous across a
 *  library thousands of notes deep, and requireNote resolves prefixes (and
 *  reports ambiguity rather than guessing) if it ever is not. */
const SHORT_ID = 8

export interface OutlineArgs extends DateArgs {
  folder?: string
  title_contains?: string
  title_starts_with?: string
  status?: string
  order: 'title' | 'newest'
  limit: number
}

export function outlineTool(lib: Library, args: OutlineArgs): string {
  const folder = folderRef(lib, args.folder)
  const { rows, total } = outlineNotes(lib, {
    ...dateBounds(args),
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with,
    status: args.status,
    limit: args.limit,
    byTitle: args.order === 'title',
    folderRef: folder
  })
  const scope = scopeLabel({
    folder,
    status: args.status,
    after: args.after,
    before: args.before,
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with
  })
  if (total === 0) return `No notes${scope ? ` ${scope}` : ''}.`

  const lines = rows.map((r) => {
    const marks = [shortDate(r.createdAt)]
    if (!folder) marks.push(r.folderName ?? 'unfiled')
    marks.push(r.status)
    if (!r.hasEnhanced) marks.push('no enhanced notes')
    return `${r.id.slice(0, SHORT_ID)}  ${r.title || '(untitled)'}  · ${marks.join(' · ')}`
  })

  // A folder filter combined with a title filter is the trap this library
  // actually contains: 8 of the 46 topic-2 notes were never filed, including
  // the largest reading assignment. Scoping to the folder drops them silently,
  // so the omission has to be stated.
  let leak = ''
  if (folder && (args.title_contains || args.title_starts_with)) {
    const unscoped = outlineNotes(lib, {
      ...dateBounds(args),
      titleContains: args.title_contains,
      titleStartsWith: args.title_starts_with,
      status: args.status,
      limit: 1,
      byTitle: false,
      folderRef: null
    })
    if (unscoped.total > total) {
      leak =
        `\n\n[${unscoped.total - total} further notes match this title filter but sit OUTSIDE folder "${folder.name}". ` +
        `Drop the folder argument to include them — where filing is inconsistent, the title is the more reliable grouping.]`
    }
  }

  const omitted =
    total > rows.length ? `\n\n[${total - rows.length} more not shown — raise limit]` : ''
  const order = args.order === 'title' ? 'title' : 'date, newest first'
  return (
    `${total} notes${scope ? ` ${scope}` : ''}, ordered by ${order}.\n\n` +
    `${lines.join('\n')}${omitted}${leak}\n\n` +
    'The leading token on each line is a short note id — pass several to get_notes to read them together.'
  )
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function topicsTool(lib: Library, args: { folder?: string }): string {
  const folder = folderRef(lib, args.folder)
  const groups = topicGroups(lib, folder)
  if (groups.length === 0) return 'The library is empty.'
  const numbered = groups.filter((g) => g.key !== '(unnumbered)')
  const lines = groups.map((g) => {
    const where = g.folders.map((f) => `${f.notes} in ${f.name}`).join(', ')
    const head = g.key === '(unnumbered)' ? 'unnumbered' : `${g.key}.*`
    const size = `${Math.round(g.chars / 1000)}K`
    return (
      `${head.padEnd(12)} ${String(g.notes).padStart(3)} notes  ${size.padStart(5)} chars  (${where})` +
      `\n${' '.repeat(13)}e.g. ${g.sample.slice(0, 66)}`
    )
  })
  const advice = numbered.length
    ? `\n\nThese groups come from the leading number in each title, across every folder — which is how a course or project library is really organised, and it does not always match the folders. To read one group, call outline with title_starts_with: "${numbered[0].key}." and NO folder argument, then get_notes with the ids.`
    : '\n\nNo numbered structure in these titles — use search_notes or outline instead.'
  const where = folder
    ? ` in ${folder.kind === 'unfiled' ? 'no folder' : `folder "${folder.name}"`}`
    : ' across the whole library'
  return `Title groups${where}:\n\n${lines.join('\n')}${advice}`
}

export interface GetNotesArgs {
  note_ids: string[]
  include: ('rough_notes' | 'enhanced_notes' | 'transcript')[]
  max_chars: number
}

/** Read many notes in one call. The alternative is one get_note per note, which
 *  for a question spanning a whole course topic means dozens of round trips —
 *  enough friction that a model will answer from three notes instead of the
 *  thirty that are actually relevant. The budget is shared across the set and
 *  spent in order, and whatever did not fit is named explicitly so the answer
 *  can say what it did not read. */
export function getNotesTool(lib: Library, args: GetNotesArgs): string {
  if (args.note_ids.length === 0) return 'No note_ids given.'
  const resolved = args.note_ids.map((ref) => requireNote(lib, ref))
  const sizes = resolved.map((n) => renderableSize(lib, n, args.include))
  const alloc = allocate(sizes, args.max_chars)

  const sections: string[] = []
  let shown = 0
  let withheld = 0
  const truncated: string[] = []

  resolved.forEach((note, i) => {
    const body = noteBody(lib, note, args.include, alloc[i])
    shown += body.text.length
    withheld += body.withheld
    if (body.withheld > 0) truncated.push(note.title || note.id.slice(0, SHORT_ID))
    sections.push(`${noteHeader(note)}\n${body.text}`)
  })

  const shortfall = withheld
    ? `\n\n[${truncated.length} of these ${resolved.length} notes were cut short; ${withheld.toLocaleString()} characters were not shown: ${truncated
        .slice(0, 10)
        .join('; ')}${truncated.length > 10 ? `; and ${truncated.length - 10} more` : ''}. Raise max_chars, or request them in smaller groups, before concluding anything about what they contain.]`
    : ''
  return `Read ${resolved.length} notes in full-or-part (${shown.toLocaleString()} characters shown${
    withheld ? `, ${withheld.toLocaleString()} withheld` : ', nothing withheld'
  }).\n\n${sections.join('\n\n---\n\n')}${shortfall}`
}

interface Rendered {
  text: string
  /** Characters this note holds that did not fit. Returned rather than only
   *  printed, so the caller can report a library-wide total instead of leaving
   *  the shortfall buried in per-note markers. */
  withheld: number
}

/** The body sections of one note, bounded by `budget`. Shared by get_note and
 *  get_notes so a note reads identically whichever way it was fetched.
 *
 *  The distinction this function exists to preserve: "there is nothing here"
 *  and "there was no room for it" are different facts, and conflating them is
 *  worse than truncating. The old code printed "(no transcript recorded)" for a
 *  note with a thousand spoken lines whenever the budget ran out first, which
 *  is an affirmative false statement about the user's own data. */
function noteBody(
  lib: Library,
  note: NoteContent,
  include: ('rough_notes' | 'enhanced_notes' | 'transcript')[],
  budget: number
): Rendered {
  const parts: string[] = []
  let left = budget
  let withheld = 0

  const section = (heading: string, source: string, emptyMsg: string, suffix = ''): void => {
    if (source.length === 0) {
      parts.push(`\n### ${heading}\n${emptyMsg}`)
      return
    }
    if (left <= 0) {
      withheld += source.length
      parts.push(
        `\n### ${heading}\n[${source.length.toLocaleString()} characters NOT SHOWN — the character budget ran out before this section. This note does have content here; raise max_chars or request fewer notes.]`
      )
      return
    }
    const { text, clipped } = clip(source, left)
    left -= text.length
    withheld += clipped
    parts.push(
      `\n### ${heading}\n${text}${
        clipped
          ? `\n[…${clipped.toLocaleString()} more characters not shown — the budget ran out, this is not the end of the note]`
          : suffix
      }`
    )
  }

  if (include.includes('enhanced_notes')) {
    section('Enhanced notes', stripSentinels(note.enhancedMd ?? ''), '(not generated for this note)')
  }
  if (include.includes('rough_notes')) {
    section('Rough notes (typed live)', stripSentinels(pmToPlainText(note.notesJson)), '(none typed)')
  }
  if (include.includes('transcript')) {
    const total = countSegments(lib, note.id)
    if (total === 0) {
      parts.push('\n### Transcript\n(no transcript recorded)')
    } else {
      const rows = getSegments(lib, note.id, 0, INLINE_TRANSCRIPT_LINES)
      const names = speakerNames(lib, note.id)
      section(
        'Transcript',
        transcriptLines(rows, names),
        '(no transcript recorded)',
        total > rows.length
          ? `\n[showing the first ${rows.length} of ${total} lines — use get_transcript for the rest]`
          : ''
      )
    }
  }
  return { text: parts.join('\n'), withheld }
}

/** Renderable size of a note, for budgeting before anything is rendered. */
function renderableSize(
  lib: Library,
  note: NoteContent,
  include: ('rough_notes' | 'enhanced_notes' | 'transcript')[]
): number {
  let n = 0
  if (include.includes('enhanced_notes')) n += stripSentinels(note.enhancedMd ?? '').length
  if (include.includes('rough_notes')) n += stripSentinels(pmToPlainText(note.notesJson)).length
  if (include.includes('transcript')) {
    n += transcriptLines(
      getSegments(lib, note.id, 0, INLINE_TRANSCRIPT_LINES),
      speakerNames(lib, note.id)
    ).length
  }
  return n
}

/** Water-filling: give every note an equal share, hand back whatever the small
 *  notes do not need, and repeat. An even split wastes the budget — fifteen
 *  short video notes each sit on an unused 12K share while the long reading
 *  assignment gets cut off. */
function allocate(sizes: number[], budget: number): number[] {
  const alloc = new Array(sizes.length).fill(0)
  let remaining = budget
  let hungry = sizes.map((_, i) => i).filter((i) => sizes[i] > 0)
  while (hungry.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / hungry.length)
    if (share <= 0) break
    let used = 0
    const next: number[] = []
    for (const i of hungry) {
      const want = sizes[i] - alloc[i]
      const give = Math.min(want, share)
      alloc[i] += give
      used += give
      if (give < want) next.push(i)
    }
    if (used === 0) break
    remaining -= used
    hungry = next
  }
  return alloc
}

export interface ListNotesArgs extends DateArgs {
  limit: number
  offset: number
  folder?: string
  title_contains?: string
  title_starts_with?: string
  status?: string
}

export function listNotesTool(lib: Library, args: ListNotesArgs): string {
  const folder = folderRef(lib, args.folder)
  const { notes, total } = listNotes(lib, {
    ...dateBounds(args),
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with,
    status: args.status,
    limit: args.limit,
    offset: args.offset,
    folderRef: folder
  })
  if (total === 0) return 'No notes match those filters.'
  const scope = scopeLabel({
    folder,
    status: args.status,
    after: args.after,
    before: args.before,
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with
  })
  // Paging past the end used to render as "Showing 131–130 of 130".
  if (notes.length === 0) {
    return `Offset ${args.offset} is past the end — ${total} notes match those filters${
      scope ? ` ${scope}` : ''
    }.`
  }
  const shown = `Showing ${args.offset + 1}–${args.offset + notes.length} of ${total} notes${
    scope ? ` ${scope}` : ''
  }, newest first.`
  return `${shown}\n\n${notes.map(noteHeader).join('\n\n')}`
}

export interface SearchNotesArgs extends DateArgs {
  query: string
  limit: number
  folder?: string
  title_contains?: string
  title_starts_with?: string
}

export function searchNotesTool(lib: Library, args: SearchNotesArgs): string {
  const folder = folderRef(lib, args.folder)
  const { hits, total, mode, terms } = searchNotes(lib, args.query, {
    ...dateBounds(args),
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with,
    limit: args.limit,
    folderRef: folder
  })
  if (terms.length === 0) return `"${args.query}" has no searchable words in it.`
  const scope = scopeLabel({
    folder,
    after: args.after,
    before: args.before,
    titleContains: args.title_contains,
    titleStartsWith: args.title_starts_with
  })
  if (hits.length === 0) {
    // Naming the scope matters: without it a folder-scoped miss reads as "this
    // is nowhere in your notes" when the note is simply in another folder.
    return scope
      ? `No notes ${scope} match ${terms.map((t) => `"${t}"`).join(' ')}. Notes outside this scope were not searched — drop the filter to search the whole library.`
      : `No notes match ${terms.map((t) => `"${t}"`).join(' ')}. Try fewer or broader terms, or search_transcript for an exact spoken phrase.`
  }
  const how =
    mode === 'all'
      ? `all terms (${terms.join(', ')})`
      : `any term (${terms.join(', ')}) — no note contained them all`
  const body = hits
    .map((h) => `${noteHeader(h)}\n  match: ${stripSentinels(h.snippet).replace(/\s+/g, ' ').trim()}`)
    .join('\n\n')
  // total, not hits.length: the page size is not the match count, and reporting
  // it as one hides every note past the limit.
  const more =
    total > hits.length
      ? `\n\n[${total - hits.length} more matching notes not shown — raise limit or narrow with folder/after/before]`
      : ''
  return `${total} notes matched ${how}${scope ? ` ${scope}` : ''}; showing ${hits.length}, best first.\n\n${body}${more}\n\nUse get_note with an id above for the full note.`
}

export interface GetNoteArgs {
  note_id: string
  include: ('rough_notes' | 'enhanced_notes' | 'transcript')[]
  max_chars: number
}

/** Transcript lines get_note will inline before telling the caller to page
 *  through get_transcript instead. A 3-hour meeting is thousands of lines. */
const INLINE_TRANSCRIPT_LINES = 150

export function getNoteTool(lib: Library, args: GetNoteArgs): string {
  const note = requireNote(lib, args.note_id)
  const body = noteBody(lib, note, args.include, args.max_chars)
  const concepts = entitiesForNote(lib, note.id)
  const conceptLine =
    concepts.length > 0
      ? `\n  concepts: ${concepts.map((c) => c.name).join(', ')} (related_notes walks these)`
      : ''
  return `${noteHeader(note)}${conceptLine}\n${body.text}`
}

export interface GetTranscriptArgs {
  note_id: string
  offset: number
  limit: number
}

export function getTranscriptTool(lib: Library, args: GetTranscriptArgs): string {
  const meta = requireNote(lib, args.note_id)
  const total = countSegments(lib, meta.id)
  if (total === 0) return `${noteHeader(meta)}\n\nThis note has no transcript.`
  const rows = getSegments(lib, meta.id, args.offset, args.limit)
  if (rows.length === 0) {
    return `${noteHeader(meta)}\n\nOffset ${args.offset} is past the end — this transcript has ${total} lines.`
  }
  const last = args.offset + rows.length
  const more = last < total ? `\n\n[lines ${last + 1}–${total} not shown — call again with offset: ${last}]` : ''
  const names = speakerNames(lib, meta.id)
  const preamble = speakerPreamble(noteSpeakerLabels(rows, names))
  return `${noteHeader(meta)}\n\nTranscript lines ${args.offset + 1}–${last} of ${total}. ${preamble}\n\n${transcriptLines(rows, names)}${more}`
}

export interface SearchTranscriptArgs extends DateArgs {
  query: string
  limit: number
  context_lines: number
  note_id?: string
  folder?: string
}

export function searchTranscriptTool(lib: Library, args: SearchTranscriptArgs): string {
  const folder = folderRef(lib, args.folder)
  const meetingId = args.note_id ? requireNote(lib, args.note_id).id : undefined
  const { hits, total, terms, dropped } = searchTranscript(lib, args.query, {
    ...dateBounds(args),
    limit: args.limit,
    contextLines: args.context_lines,
    meetingId,
    folderRef: folder
  })
  if (terms.length === 0) return `"${args.query}" has no searchable words in it.`
  const termsNote =
    dropped > 0 ? ` (only the first ${terms.length} terms were used; ${dropped} ignored)` : ''
  if (hits.length === 0) {
    return `Nothing spoken matches ${terms.map((t) => `"${t}"`).join(' + ')}${termsNote}. Every term must appear in the same spoken line — try a single distinctive word, or search_notes for a topic-level match.`
  }

  // Hits arrive grouped by note (ordered by note date, then position), so the
  // header is printed once per note rather than once per matching line — a
  // word said twenty times in one meeting used to repeat its header twenty
  // times and bury the actual excerpts.
  const blocks: string[] = []
  let currentNote: string | null = null
  // Hits span notes and names are per note, so the map is resolved once per
  // note as the grouped hits move through them, not once for the whole result.
  let names: SpeakerNames | undefined
  for (const h of hits) {
    if (h.note.id !== currentNote) {
      currentNote = h.note.id
      names = speakerNames(lib, h.note.id)
      blocks.push(noteHeader(h.note))
    }
    blocks.push(
      [
        ...h.before.map((l) => `  ${transcriptLine(l, names)}`),
        `> ${transcriptLine(h.line, names)}`,
        ...h.after.map((l) => `  ${transcriptLine(l, names)}`)
      ].join('\n')
    )
  }
  const more =
    total > hits.length
      ? `\n\n[${total - hits.length} more matching lines not shown — raise limit or narrow with note_id/folder]`
      : ''
  return `${total} spoken lines match ${terms.map((t) => `"${t}"`).join(' + ')}${termsNote}; showing ${hits.length}, newest note first.\n\n${blocks.join('\n\n')}${more}`
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

/** Resolve an optional folder reference for a write. Distinguishes "leave it
 *  alone" (undefined) from "unfile it" ("unfiled") from a real folder. Throws
 *  with the real folder names on a miss, like the read tools do. */
function folderIdForWrite(lib: Library, folder: string | undefined): string | null | undefined {
  if (folder === undefined) return undefined
  const resolved = folderRef(lib, folder)
  return resolved === null || resolved.kind === 'unfiled' ? null : resolved.id
}

export interface CreateNoteArgs {
  title: string
  folder?: string
  content_markdown?: string
}

export function createNoteTool(lib: Library, args: CreateNoteArgs): string {
  const title = args.title.trim()
  if (!title) throw new Error('title must not be empty.')
  const folderId = folderIdForWrite(lib, args.folder) ?? null
  const folderName = args.folder !== undefined ? folderRef(lib, args.folder)?.name : undefined
  const notesJson = markdownToPmDoc(args.content_markdown ?? '')
  const { id } = createNote(lib, { title, folderId, notesJson })
  const where = folderId ? ` in folder "${folderName}"` : ''
  return `Created note ${id.slice(0, SHORT_ID)} "${title}"${where}. Full id: ${id}. It opens in the app as an ordinary editable note; use update_note to add to it.`
}

export interface UpdateNoteArgs {
  note_id: string
  title?: string
  folder?: string
  append_markdown?: string
  replace_markdown?: string
}

export function updateNoteTool(lib: Library, args: UpdateNoteArgs): string {
  const note = requireNote(lib, args.note_id)
  if (note.status === 'recording') {
    throw new Error(
      `Note ${note.id.slice(0, SHORT_ID)} is being recorded right now — edits would race the live transcript. Wait for the recording to stop.`
    )
  }
  if (args.append_markdown !== undefined && args.replace_markdown !== undefined) {
    throw new Error('Pass append_markdown or replace_markdown, not both.')
  }
  const changes: string[] = []
  let notesJson: string | undefined
  if (args.append_markdown !== undefined) {
    if (!args.append_markdown.trim()) throw new Error('append_markdown is empty.')
    notesJson = appendMarkdownToDoc(note.notesJson, args.append_markdown)
    changes.push('appended to its notes')
  }
  if (args.replace_markdown !== undefined) {
    notesJson = markdownToPmDoc(args.replace_markdown)
    changes.push('replaced its notes')
  }
  const title = args.title?.trim()
  if (args.title !== undefined) {
    if (!title) throw new Error('title must not be empty.')
    changes.push(`retitled to "${title}"`)
  }
  const folderId = folderIdForWrite(lib, args.folder)
  if (folderId !== undefined) {
    const name = folderId === null ? null : folderRef(lib, args.folder)?.name
    changes.push(folderId === null ? 'unfiled' : `moved to folder "${name}"`)
  }
  if (changes.length === 0) {
    throw new Error(
      'Nothing to change — pass title, folder, append_markdown, or replace_markdown.'
    )
  }
  updateNote(lib, { id: note.id, title, notesJson, folderId })
  return `Note ${note.id.slice(0, SHORT_ID)} "${title ?? note.title}": ${changes.join(', ')}.`
}

export function createFolderTool(lib: Library, args: { name: string }): string {
  const name = args.name.trim()
  if (!name) throw new Error('name must not be empty.')
  if (/^(unfiled|none|no folder)$/i.test(name)) {
    throw new Error(`"${name}" is reserved (it means "no folder").`)
  }
  const existing = listFolderNames(lib).find((n) => n.toLowerCase() === name.toLowerCase())
  if (existing) {
    throw new Error(`A folder named "${existing}" already exists.`)
  }
  const folder = createFolder(lib, name)
  return `Created folder "${name}" (id ${folder.id.slice(0, SHORT_ID)}).`
}

export function renameFolderTool(lib: Library, args: { folder: string; new_name: string }): string {
  const resolved = folderRef(lib, args.folder)
  if (!resolved || resolved.kind === 'unfiled' || resolved.id === null) {
    throw new Error('rename_folder needs a real folder, not "unfiled".')
  }
  const name = args.new_name.trim()
  if (!name) throw new Error('new_name must not be empty.')
  const clash = listFolderNames(lib).find(
    (n) => n.toLowerCase() === name.toLowerCase() && n.toLowerCase() !== resolved.name.toLowerCase()
  )
  if (clash) throw new Error(`A folder named "${clash}" already exists.`)
  renameFolder(lib, resolved.id, name)
  return `Folder "${resolved.name}" renamed to "${name}".`
}

export function deleteNoteTool(lib: Library, args: { note_id: string; confirm?: string }): string {
  const note = requireNote(lib, args.note_id)
  if (note.status === 'recording') {
    throw new Error('This note is being recorded right now and cannot be deleted.')
  }
  const short = note.id.slice(0, SHORT_ID)
  const segments = countSegments(lib, note.id)
  const what = [
    `"${note.title || '(untitled)'}" (${short})`,
    segments > 0 ? `${segments} transcript lines` : 'no transcript',
    note.enhancedMd ? 'enhanced notes' : 'no enhanced notes'
  ].join(' — ')
  if (!args.confirm) {
    const token = issueConfirmToken('note', note.id)
    return `This will PERMANENTLY delete ${what}, including its transcript, chunks, and chat thread. To proceed, call delete_note again with confirm: "${token}" (valid 5 minutes). There is no undo.`
  }
  if (!consumeConfirmToken(args.confirm, 'note', note.id)) {
    throw new Error(
      'That confirmation token is not valid for this note (wrong token, expired, or already used). Call delete_note without confirm to get a fresh one.'
    )
  }
  deleteNote(lib, note.id)
  return `Deleted note ${what}.`
}

export function deleteFolderTool(lib: Library, args: { folder: string; confirm?: string }): string {
  const resolved = folderRef(lib, args.folder)
  if (!resolved || resolved.kind === 'unfiled' || resolved.id === null) {
    throw new Error('delete_folder needs a real folder, not "unfiled".')
  }
  const noteCount = (
    lib.db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE folder_id = ?').get(resolved.id) as {
      n: number
    }
  ).n
  if (!args.confirm) {
    const token = issueConfirmToken('folder', resolved.id)
    return `This will delete folder "${resolved.name}" and its chat thread. Its ${noteCount} note(s) are NOT deleted — they become unfiled. To proceed, call delete_folder again with confirm: "${token}" (valid 5 minutes).`
  }
  if (!consumeConfirmToken(args.confirm, 'folder', resolved.id)) {
    throw new Error(
      'That confirmation token is not valid for this folder (wrong token, expired, or already used). Call delete_folder without confirm to get a fresh one.'
    )
  }
  deleteFolder(lib, resolved.id)
  return `Deleted folder "${resolved.name}"; ${noteCount} note(s) moved to unfiled.`
}

// ---------------------------------------------------------------------------
// App-mediated tools (run inside the app via the control socket)
// ---------------------------------------------------------------------------

export interface ImportRecordingArgs {
  path: string
  title?: string
  folder?: string
}

export async function importRecordingTool(lib: Library, args: ImportRecordingArgs): Promise<string> {
  const path = args.path.trim()
  if (!path) throw new Error('path is required — an absolute path to an audio or video file.')
  const response = await appRequest(lib, 'import-recording', {
    path,
    title: args.title,
    folder: args.folder
  })
  const noteId = typeof response.noteId === 'string' ? response.noteId : ''
  return [
    `Import started: note ${noteId.slice(0, SHORT_ID)} (full id: ${noteId}).`,
    'The app is transcribing the file in the background — the transcript appears on the note when it finishes (typically well under a minute per hour of audio).',
    'Check progress with get_note or get_transcript; the note status becomes "recorded" when transcription lands.'
  ].join('\n')
}

export interface StartRecordingArgs {
  title?: string
  folder?: string
}

export async function startRecordingTool(lib: Library, args: StartRecordingArgs): Promise<string> {
  const response = await appRequest(lib, 'start-recording', {
    title: args.title,
    folder: args.folder
  })
  const noteId = typeof response.noteId === 'string' ? response.noteId : ''
  return [
    `Recording requested: note ${noteId.slice(0, SHORT_ID)} (full id: ${noteId}).`,
    'The app is starting capture — this takes a few seconds, and needs microphone permission on the Mac unless the user records system audio only.',
    'Confirm with recording_status; the live transcript is readable with get_transcript while recording runs.'
  ].join('\n')
}

export async function stopRecordingTool(lib: Library): Promise<string> {
  const response = await appRequest(lib, 'stop-recording', {})
  const noteId = typeof response.noteId === 'string' ? response.noteId : ''
  return `Recording stopped; note ${noteId.slice(0, SHORT_ID)} now holds the full transcript (status "recorded"). Full id: ${noteId}.`
}

export async function recordingStatusTool(lib: Library): Promise<string> {
  const response = await appRequest(lib, 'recording-status', {})
  const state = typeof response.state === 'string' ? response.state : 'unknown'
  if (state === 'idle' || !response.noteId) {
    return 'Nothing is being recorded right now.'
  }
  const noteId = String(response.noteId)
  const title = typeof response.title === 'string' && response.title ? ` "${response.title}"` : ''
  const startedAt = typeof response.startedAt === 'number' ? response.startedAt : null
  const runtime = startedAt ? ` — running ${Math.max(0, Math.round((Date.now() - startedAt) / 60000))} min` : ''
  return `${state}: note ${noteId.slice(0, SHORT_ID)}${title}${runtime}. Full id: ${noteId}.`
}

// ---------------------------------------------------------------------------
// Knowledge-graph tools
// ---------------------------------------------------------------------------

export interface GetGraphArgs {
  folder?: string
  limit: number
}

export function getGraphTool(lib: Library, args: GetGraphArgs): string {
  if (!hasGraph(lib)) {
    return 'This library has no knowledge graph yet — open the Granola Clone app once to migrate it.'
  }
  const folder = folderRef(lib, args.folder)
  const entities = graphEntities(lib, folder, args.limit)
  if (entities.length === 0) {
    return `No concepts extracted yet${folder ? ` ${scopeLabel({ folder })}` : ''}. Extraction runs in the app shortly after notes get content (it needs an Anthropic key set there).`
  }
  const blocks = entities.map((e) => {
    const notes = e.notes
      .map((n) => `    ${n.id.slice(0, SHORT_ID)}  ${n.title || '(untitled)'}`)
      .join('\n')
    const extra = e.noteCount > e.notes.length ? `\n    …and ${e.noteCount - e.notes.length} more` : ''
    return `${e.name} (${e.kind}, ${e.noteCount} note${e.noteCount === 1 ? '' : 's'})\n${notes}${extra}`
  })
  const scope = folder ? ` ${scopeLabel({ folder })}` : ''
  return `Knowledge graph${scope}: ${entities.length} concepts, most-connected first. Each note id works with get_note/get_notes; use related_notes to walk outward from one note.\n\n${blocks.join('\n\n')}`
}

export function relatedNotesTool(lib: Library, args: { note_id: string; limit: number }): string {
  if (!hasGraph(lib)) {
    return 'This library has no knowledge graph yet — open the Granola Clone app once to migrate it.'
  }
  const note = requireNote(lib, args.note_id)
  const related = relatedNotesFor(lib, note.id, args.limit)
  if (related.length === 0) {
    return `No related notes found for "${note.title || note.id.slice(0, SHORT_ID)}" yet. Either its concepts have not been extracted (give the app a minute) or nothing else in the library shares them.`
  }
  const lines = related.map(
    (r) =>
      `${r.id.slice(0, SHORT_ID)}  ${r.title || '(untitled)'}\n    shared: ${r.shared.join(', ')}`
  )
  return `Notes related to "${note.title || note.id.slice(0, SHORT_ID)}" through shared concepts, strongest ties first:\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Export tools (run inside the app via the control socket)
// ---------------------------------------------------------------------------

export interface ExportNoteArgs {
  note_id: string
  format: 'md' | 'html' | 'pdf' | 'docx'
  dest_path: string
}

export async function exportNoteTool(lib: Library, args: ExportNoteArgs): Promise<string> {
  const note = requireNote(lib, args.note_id)
  const response = await appRequest(lib, 'export-note', {
    noteId: note.id,
    format: args.format,
    destPath: args.dest_path
  })
  return `Exported "${note.title || note.id.slice(0, SHORT_ID)}" as ${args.format} to ${String(response.path)}.`
}

export interface ExportLibraryArgs {
  format: 'obsidian_vault' | 'json'
  dest_path: string
  folder?: string
}

export async function exportLibraryTool(lib: Library, args: ExportLibraryArgs): Promise<string> {
  if (args.folder !== undefined) folderRef(lib, args.folder) // validate early with real names
  if (args.format === 'json') {
    const response = await appRequest(lib, 'export-json', {
      folder: args.folder,
      destPath: args.dest_path
    })
    return `Exported the ${args.folder ? `"${args.folder}" folder` : 'library'} as a JSON bundle to ${String(response.path)}. It carries every note's markdown, transcript, concepts, and relations — schema-versioned for machine consumption.`
  }
  const response = await appRequest(lib, 'export-vault', {
    folder: args.folder,
    destPath: args.dest_path
  })
  return `Exported ${String(response.files)} files as an Obsidian vault at ${String(response.path)}. Notes carry [[wikilinks]] to Concepts/ stub pages, so Obsidian's graph view mirrors the app's knowledge graph. Open the folder as a vault in Obsidian.`
}

export interface ExportNotionArgs {
  note_id?: string
  folder?: string
}

export async function exportNotionTool(lib: Library, args: ExportNotionArgs): Promise<string> {
  if (args.note_id) {
    const note = requireNote(lib, args.note_id)
    const response = await appRequest(lib, 'export-notion', { noteId: note.id })
    return `Exported "${note.title || note.id.slice(0, SHORT_ID)}" to Notion: ${String(response.url)}`
  }
  if (args.folder !== undefined) folderRef(lib, args.folder)
  const response = await appRequest(lib, 'export-notion', { folder: args.folder })
  return `Exported ${String(response.pages)} notes to Notion under ${String(response.url)}`
}
