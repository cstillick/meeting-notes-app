import type { Channel, TranscriptSegment } from '@shared/types'
import { getDb } from './database'

interface SegmentRow {
  id: number
  meeting_id: string
  channel: Channel
  text: string
  start_ms: number
  end_ms: number
}

export function insertSegment(
  meetingId: string,
  channel: Channel,
  text: string,
  startMs: number,
  endMs: number
): void {
  getDb()
    .prepare(
      'INSERT INTO transcript_segments (meeting_id, channel, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)'
    )
    .run(meetingId, channel, text, startMs, endMs)
}

export function getSegments(meetingId: string): TranscriptSegment[] {
  const rows = getDb()
    .prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms')
    .all(meetingId) as unknown as SegmentRow[]
  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    channel: r.channel,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms
  }))
}
