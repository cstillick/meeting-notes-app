import type { Channel, TranscriptSegment } from '@shared/types'
import { getDb } from './database'

interface SegmentRow {
  id: number
  meeting_id: string
  channel: Channel
  text: string
  start_ms: number
  end_ms: number
  speaker: number | null
}

/** @returns false when the row already existed — callers must not broadcast a
 *  segment the DB ignored, or the live view shows what a reload won't. */
export function insertSegment(
  meetingId: string,
  channel: Channel,
  text: string,
  startMs: number,
  endMs: number,
  speaker: number | null = null
): boolean {
  // OR IGNORE: Deepgram retransmits finals after reconnects; the unique index
  // (idx_segments_unique) makes replays a no-op instead of a duplicate row.
  const info = getDb()
    .prepare(
      'INSERT OR IGNORE INTO transcript_segments (meeting_id, channel, text, start_ms, end_ms, speaker) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(meetingId, channel, text, startMs, endMs, speaker)
  return info.changes > 0
}

/** Highest end_ms persisted for a meeting (0 if none). A re-recording resumes
 *  its timeline after this so new segments append past the existing transcript
 *  instead of restarting near 0 — which would interleave them into the earlier
 *  session and, on exact (time, text) collisions, get them dropped by the
 *  INSERT OR IGNORE in insertSegment (idx_segments_unique). */
export function getMaxEndMs(meetingId: string): number {
  const row = getDb()
    .prepare('SELECT MAX(end_ms) AS maxEnd FROM transcript_segments WHERE meeting_id = ?')
    .get(meetingId) as { maxEnd: number | null } | undefined
  return row?.maxEnd ?? 0
}

export function getSegments(meetingId: string): TranscriptSegment[] {
  // ", id" tiebreak: mic and system segments routinely share a start_ms, and
  // start_ms alone lets tied lines swap order between reads — the MCP server
  // already orders this way, so the app must match or the same transcript
  // renders differently in the two surfaces.
  const rows = getDb()
    .prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms, id')
    .all(meetingId) as unknown as SegmentRow[]
  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    channel: r.channel,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    speaker: r.speaker
  }))
}
