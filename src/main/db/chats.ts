import type { ChatMessage } from '@shared/types'
import { getDb } from './database'

interface ChatRow {
  id: number
  meeting_id: string | null
  folder_id: string | null
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

/** WHERE clause + bind params selecting one thread: a note's, a folder's, or
 *  the global thread (both ids NULL). The three are mutually exclusive. */
function scopeClause(
  meetingId: string | null,
  folderId: string | null
): { where: string; params: string[] } {
  if (meetingId !== null) return { where: 'meeting_id = ?', params: [meetingId] }
  if (folderId !== null) return { where: 'folder_id = ?', params: [folderId] }
  return { where: 'meeting_id IS NULL AND folder_id IS NULL', params: [] }
}

/** Last `limit` messages of a thread, oldest first. Both ids null = global.
 *  Blank rows are skipped rather than replayed: an assistant turn stored as ''
 *  (a refusal saved before stop_reason was checked) makes every later send on
 *  that thread 400 — the API rejects empty message content. */
export function getChatHistory(
  meetingId: string | null,
  folderId: string | null,
  limit = 40
): ChatMessage[] {
  const { where, params } = scopeClause(meetingId, folderId)
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages WHERE ${where} AND TRIM(content) <> '' ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit) as unknown as ChatRow[]
  return rows.reverse().map(toMessage)
}

export function insertChatMessage(
  meetingId: string | null,
  folderId: string | null,
  role: 'user' | 'assistant',
  content: string
): ChatMessage {
  const createdAt = Date.now()
  const result = getDb()
    .prepare(
      'INSERT INTO chat_messages (meeting_id, folder_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(meetingId, folderId, role, content, createdAt)
  return {
    id: Number(result.lastInsertRowid),
    meetingId,
    role,
    content,
    createdAt
  }
}

export function clearChat(meetingId: string | null, folderId: string | null): void {
  const { where, params } = scopeClause(meetingId, folderId)
  getDb()
    .prepare(`DELETE FROM chat_messages WHERE ${where}`)
    .run(...params)
}
