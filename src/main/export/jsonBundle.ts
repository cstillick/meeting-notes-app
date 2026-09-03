// Machine-readable full export: the whole library (or one folder) as one
// versioned JSON document — backup format and agent-ingestible corpus in one.
// Everything text-shaped is included in both its stored form and as plain
// markdown, so a consumer needs no ProseMirror knowledge.
import type { TranscriptSegment } from '@shared/types'
import { pmToPlainText, speakerLabel } from '../enhance/prompt'
import { pmToMarkdown } from '../enhance/pmToMarkdown'
import { getMeeting, listMeetings, listMeetingsInFolder } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { speakerNameMap } from '../db/speakers'
import { listFolders } from '../db/folders'
import { listEntitiesForNote, relatedNotes } from '../db/entities'
import { stripSentinels } from './markdown'

export const BUNDLE_VERSION = 1

interface BundleSegment {
  speaker: string
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
}

function toBundleSegment(s: TranscriptSegment, names?: ReadonlyMap<string, string>): BundleSegment {
  return {
    speaker: speakerLabel(
      {
        channel: s.channel,
        text: s.text,
        startMs: s.startMs,
        speaker: s.speaker
      },
      names
    ),
    channel: s.channel,
    text: s.text,
    startMs: s.startMs,
    endMs: s.endMs
  }
}

/** One note's transcript with speaker names resolved. The name map is looked up
 *  once per note rather than per segment. */
function bundleTranscript(meetingId: string): BundleSegment[] {
  const names = speakerNameMap(meetingId)
  return getSegments(meetingId).map((seg) => toBundleSegment(seg, names))
}

export function buildJsonBundle(folderId: string | null): string {
  const folders = listFolders()
  const summaries = folderId === null ? listMeetings() : listMeetingsInFolder(folderId)

  const notes = summaries.flatMap((summary) => {
    const meeting = getMeeting(summary.id)
    if (!meeting) return []
    const entities = listEntitiesForNote(meeting.id)
    return [
      {
        id: meeting.id,
        title: meeting.title,
        createdAt: meeting.createdAt,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        status: meeting.status,
        folderId: meeting.folderId,
        roughNotesMarkdown: pmToMarkdown(meeting.notesJson) || pmToPlainText(meeting.notesJson),
        enhancedMarkdown: meeting.enhancedMd ? stripSentinels(meeting.enhancedMd) : null,
        enhancedAt: meeting.enhancedAt,
        transcript: bundleTranscript(meeting.id),
        concepts: entities.map((e) => ({ name: e.name, kind: e.kind, weight: e.weight })),
        related: relatedNotes(meeting.id, 8).map((r) => ({
          id: r.id,
          title: r.title,
          score: r.score,
          shared: r.shared
        }))
      }
    ]
  })

  return JSON.stringify(
    {
      format: 'granola-clone-library',
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      scope: folderId === null ? 'library' : { folderId },
      folders: folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })),
      notes
    },
    null,
    2
  )
}
