// Markdown export: single notes, and a whole-library/folder Obsidian vault.
//
// The vault is a real knowledge graph in Obsidian's terms: every note carries
// [[wikilinks]] to its extracted concepts, and every concept gets a stub page
// under Concepts/ listing the notes that carry it — so Obsidian's graph view
// renders the same bipartite structure the in-app graph shows.
import type { Meeting, TranscriptSegment } from '@shared/types'
import { formatTimestamp, pmToPlainText, speakerLabel } from '../enhance/prompt'
import { pmToMarkdown } from '../enhance/pmToMarkdown'
import { getMeeting, listMeetings, listMeetingsInFolder } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { speakerNameMap } from '../db/speakers'
import { listFolders } from '../db/folders'
import { listEntitiesForNote, relatedNotes } from '../db/entities'

/** The ⟦U⟧ provenance markers mean nothing outside the app. */
export function stripSentinels(md: string): string {
  return md.replace(/[⟦⟧]\/?U[⟦⟧]/g, '').replace(/[⟦⟧]/g, '')
}

/** Filesystem- and wikilink-safe name: no path or link syntax, bounded. */
export function safeName(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|#^[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

export interface NoteMarkdownOptions {
  /** Include the full transcript section. */
  transcript: boolean
  /** Emit YAML frontmatter (Obsidian-friendly). */
  frontmatter: boolean
  /** Emit [[wikilinks]] for concepts and related notes (vault exports). */
  wikilinks: boolean
  /** Resolves a note id to its vault filename base (for related-note links). */
  linkFor?: (noteId: string) => string | null
}

function yamlEscape(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** One note as Markdown. Enhanced notes are the primary body when they exist;
 *  the rough notes always follow (they are the user's own words). */
export function noteToMarkdown(
  meeting: Meeting,
  segments: TranscriptSegment[],
  opts: NoteMarkdownOptions
): string {
  const title = meeting.title || 'Untitled note'
  const entities = listEntitiesForNote(meeting.id)
  const parts: string[] = []

  if (opts.frontmatter) {
    const lines = [
      '---',
      `id: ${meeting.id}`,
      `title: ${yamlEscape(title)}`,
      `created: ${new Date(meeting.createdAt).toISOString()}`
    ]
    if (meeting.startedAt) lines.push(`recorded: ${new Date(meeting.startedAt).toISOString()}`)
    if (entities.length > 0) {
      lines.push('tags:')
      for (const e of entities) lines.push(`  - ${yamlEscape(e.name.replace(/\s+/g, '-'))}`)
    }
    lines.push('---', '')
    parts.push(lines.join('\n'))
  }

  parts.push(`# ${title}`)

  if (entities.length > 0) {
    const names = opts.wikilinks
      ? entities.map((e) => `[[${safeName(e.name, 'Concept')}]]`)
      : entities.map((e) => e.name)
    parts.push(`Concepts: ${names.join(' · ')}`)
  }

  if (meeting.enhancedMd) {
    // The stored markdown already begins with its own H1 title — drop it, the
    // export owns the title line.
    const body = stripSentinels(meeting.enhancedMd)
      .replace(/^\s*#\s+[^\n]*\n/, '')
      .trim()
    if (body) parts.push(body)
  }

  const rough = pmToMarkdown(meeting.notesJson) || pmToPlainText(meeting.notesJson)
  if (rough.trim()) {
    parts.push(`## My notes\n\n${rough.trim()}`)
  }

  if (opts.transcript && segments.length > 0) {
    // One lookup for the whole note. This single call covers md, html, pdf,
    // docx and the Obsidian vault — export/index.ts routes them all through
    // noteToMarkdown.
    const names = speakerNameMap(meeting.id)
    const lines = segments.map(
      (s) =>
        `[${formatTimestamp(s.startMs)}] **${speakerLabel(
          {
            channel: s.channel,
            text: s.text,
            startMs: s.startMs,
            speaker: s.speaker
          },
          names
        )}**: ${s.text}`
    )
    parts.push(`## Transcript\n\n${lines.join('\n')}`)
  }

  if (opts.wikilinks && opts.linkFor) {
    const related = relatedNotes(meeting.id, 8)
    const links = related
      .map((r) => {
        const target = opts.linkFor!(r.id)
        return target ? `- [[${target}]] — via ${r.shared.join(', ')}` : null
      })
      .filter(Boolean)
    if (links.length > 0) parts.push(`## Related\n\n${links.join('\n')}`)
  }

  return `${parts.join('\n\n')}\n`
}

export interface VaultFile {
  /** Vault-relative path, e.g. "Econ/Fiscal policy lecture.md". */
  path: string
  content: string
}

/** The whole library (or one folder) as an Obsidian vault: one file per note
 *  grouped by folder, plus a Concepts/ stub per entity so the concept nodes
 *  appear in Obsidian's graph exactly as they do in the app's. */
export function buildVault(folderId: string | null): VaultFile[] {
  const folders = new Map(listFolders().map((f) => [f.id, f.name]))
  const notes = folderId === null ? listMeetings() : listMeetingsInFolder(folderId)

  // Stable, collision-free filename base per note.
  const usedNames = new Set<string>()
  const nameFor = new Map<string, string>()
  for (const n of notes) {
    let base = safeName(n.title, `Untitled ${n.id.slice(0, 8)}`)
    if (usedNames.has(base.toLowerCase())) base = `${base} (${n.id.slice(0, 8)})`
    usedNames.add(base.toLowerCase())
    nameFor.set(n.id, base)
  }

  const files: VaultFile[] = []
  const conceptNotes = new Map<string, { kind: string; notes: string[] }>()

  for (const summary of notes) {
    const meeting = getMeeting(summary.id)
    if (!meeting) continue
    const dir =
      meeting.folderId !== null
        ? safeName(folders.get(meeting.folderId) ?? 'Folder', 'Folder')
        : 'Unfiled'
    const base = nameFor.get(meeting.id)!
    const md = noteToMarkdown(meeting, getSegments(meeting.id), {
      transcript: true,
      frontmatter: true,
      wikilinks: true,
      linkFor: (id) => nameFor.get(id) ?? null
    })
    files.push({ path: `${dir}/${base}.md`, content: md })

    for (const e of listEntitiesForNote(meeting.id)) {
      const cname = safeName(e.name, 'Concept')
      const entry = conceptNotes.get(cname) ?? { kind: e.kind, notes: [] }
      entry.notes.push(base)
      conceptNotes.set(cname, entry)
    }
  }

  for (const [cname, entry] of conceptNotes) {
    const body = [
      `# ${cname}`,
      '',
      `*${entry.kind}* — appears in ${entry.notes.length} note${entry.notes.length === 1 ? '' : 's'}:`,
      '',
      ...entry.notes.map((n) => `- [[${n}]]`),
      ''
    ].join('\n')
    files.push({ path: `Concepts/${cname}.md`, content: body })
  }

  return files
}
