// Export orchestration: one place that turns notes into files or Notion
// pages. Used by the in-app Export menus (with save dialogs in ipc.ts) and by
// the agent control socket (with explicit destination paths).
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getMeeting } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { listFolders } from '../db/folders'
import { listMeetingsInFolder, listMeetings } from '../db/meetings'
import { getNotionParentPageId, getNotionToken } from '../settings'
import { buildVault, noteToMarkdown, safeName, stripSentinels } from './markdown'
import { markdownToHtmlDocument } from './html'
import { htmlToPdf } from './pdf'
import { markdownToDocx } from './docx'
import { buildJsonBundle } from './jsonBundle'
import {
  createNotionPage,
  markdownToNotionBlocks,
  normalizePageId,
  type NotionPageResult
} from './notion'

export type NoteExportFormat = 'md' | 'html' | 'pdf' | 'docx'
export const NOTE_EXPORT_FORMATS: NoteExportFormat[] = ['md', 'html', 'pdf', 'docx']

function requireMeeting(noteId: string): NonNullable<ReturnType<typeof getMeeting>> {
  const meeting = getMeeting(noteId)
  if (!meeting) throw new Error(`No note with id ${noteId}.`)
  return meeting
}

function subtitle(meeting: ReturnType<typeof requireMeeting>): string {
  const when = new Date(meeting.startedAt ?? meeting.createdAt).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `Exported from Granola Clone · ${when}`
}

/** Suggested filename base for a note export. */
export function exportFileBase(noteId: string): string {
  const meeting = requireMeeting(noteId)
  return safeName(meeting.title, `note-${meeting.id.slice(0, 8)}`)
}

/** One note → one file at destPath, format decided by the caller. */
export async function exportNoteToFile(
  noteId: string,
  format: NoteExportFormat,
  destPath: string
): Promise<void> {
  const meeting = requireMeeting(noteId)
  const segments = getSegments(noteId)
  const markdown = noteToMarkdown(meeting, segments, {
    transcript: true,
    frontmatter: format === 'md',
    wikilinks: false
  })
  mkdirSync(dirname(destPath), { recursive: true })
  switch (format) {
    case 'md':
      writeFileSync(destPath, markdown, 'utf8')
      return
    case 'html':
      writeFileSync(
        destPath,
        markdownToHtmlDocument(meeting.title || 'Untitled note', subtitle(meeting), markdown),
        'utf8'
      )
      return
    case 'pdf': {
      const html = markdownToHtmlDocument(
        meeting.title || 'Untitled note',
        subtitle(meeting),
        markdown
      )
      writeFileSync(destPath, await htmlToPdf(html))
      return
    }
    case 'docx':
      writeFileSync(destPath, markdownToDocx(markdown))
      return
  }
}

/** The library (or one folder) as an Obsidian vault under destDir. */
export function exportVaultToDir(folderId: string | null, destDir: string): { files: number } {
  const files = buildVault(folderId)
  if (files.length === 0) throw new Error('Nothing to export — the scope has no notes.')
  for (const file of files) {
    const path = join(destDir, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content, 'utf8')
  }
  return { files: files.length }
}

/** The library (or one folder) as one JSON bundle file. */
export function exportJsonToFile(folderId: string | null, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, buildJsonBundle(folderId), 'utf8')
}

function notionCredentials(): { token: string; parentPageId: string } {
  const token = getNotionToken()
  if (!token) {
    throw new Error('No Notion token set — add your integration token in Settings first.')
  }
  const parentPageId = getNotionParentPageId()
  if (!parentPageId) {
    throw new Error(
      'No Notion parent page set — paste the id (or URL) of the page exports should land under in Settings, and share that page with your integration.'
    )
  }
  return { token, parentPageId: normalizePageId(parentPageId) }
}

/** One note → one Notion page under the configured parent. */
export async function exportNoteToNotion(
  noteId: string,
  parentOverride?: string
): Promise<NotionPageResult> {
  const { token, parentPageId } = notionCredentials()
  const meeting = requireMeeting(noteId)
  const markdown = noteToMarkdown(meeting, getSegments(noteId), {
    transcript: false,
    frontmatter: false,
    wikilinks: false
  })
  // The markdown begins with the title H1; the Notion page title carries it.
  const body = markdown.replace(/^\s*#\s+[^\n]*\n/, '')
  return createNotionPage({
    token,
    parentPageId: parentOverride ?? parentPageId,
    title: meeting.title || 'Untitled note',
    blocks: markdownToNotionBlocks(body)
  })
}

/** A folder (or the whole library) → a container page with one child page per
 *  note. Returns the container and how many pages were created. */
export async function exportScopeToNotion(
  folderId: string | null
): Promise<{ container: NotionPageResult; pages: number }> {
  const { token, parentPageId } = notionCredentials()
  const folderName =
    folderId === null ? null : (listFolders().find((f) => f.id === folderId)?.name ?? 'Folder')
  const notes = folderId === null ? listMeetings() : listMeetingsInFolder(folderId)
  if (notes.length === 0) throw new Error('Nothing to export — the scope has no notes.')

  const stamp = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
  const container = await createNotionPage({
    token,
    parentPageId,
    title: `${folderName ?? 'Notetaker library'} — ${stamp}`,
    blocks: markdownToNotionBlocks(
      `Exported from Granola Clone: ${notes.length} note${notes.length === 1 ? '' : 's'}.`
    )
  })

  let pages = 0
  for (const note of notes) {
    await exportNoteToNotion(note.id, container.id)
    pages++
  }
  return { container, pages }
}

/** Concepts line + enhanced/rough content already flow through
 *  noteToMarkdown; re-export the pieces other modules need. */
export { stripSentinels }
