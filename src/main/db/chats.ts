import type { ChatMessage } from '@shared/types'
import { getDb } from './database'

interface ChatRow {
  id: number
  meeting_id: string | null
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

function toMessage(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at
  }
}

/** Last `limit` messages of a thread, oldest first. meetingId null = global thread. */
export function getChatHistory(meetingId: string | null, limit = 40): ChatMessage[] {
  const db = getDb()
  const rows = (
    meetingId === null
      ? db
          .prepare(
            'SELECT * FROM chat_messages WHERE meeting_id IS NULL ORDER BY id DESC LIMIT ?'
          )
          .all(limit)
      : db
          .prepare('SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY id DESC LIMIT ?')
          .all(meetingId, limit)
  ) as unknown as ChatRow[]
  return rows.reverse().map(toMessage)
}

export function insertChatMessage(
  meetingId: string | null,
  role: 'user' | 'assistant',
  content: string
): ChatMessage {
  const createdAt = Date.now()
  const result = getDb()
    .prepare(
      'INSERT INTO chat_messages (meeting_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(meetingId, role, content, createdAt)
  return {
    id: Number(result.lastInsertRowid),
    meetingId,
    role,
    content,
    createdAt
  }
}

export function clearChat(meetingId: string | null): void {
  const db = getDb()
  if (meetingId === null) {
    db.prepare('DELETE FROM chat_messages WHERE meeting_id IS NULL').run()
  } else {
    db.prepare('DELETE FROM chat_messages WHERE meeting_id = ?').run(meetingId)
  }
}
