// Streams Claude's answers to floating-chat questions, per thread.
// Opus 4.8+: no temperature/top_p/top_k (they 400); adaptive thinking on.
import Anthropic from '@anthropic-ai/sdk'
import { EventEmitter } from 'events'
import { chatKeyFor, type ChatMessage, type ChatSendRequest } from '@shared/types'
import { getAnthropicKey, getModel } from '../settings'
import { getMeeting } from '../db/meetings'
import { getFolder } from '../db/folders'
import { getSegments } from '../db/transcripts'
import { getChatHistory, insertChatMessage } from '../db/chats'
import {
  CHAT_FOLDER_SYSTEM,
  CHAT_GLOBAL_SYSTEM,
  CHAT_MEETING_SYSTEM,
  buildFolderContext,
  buildGlobalContext,
  buildMeetingContext
} from './prompt'

export class ChatService extends EventEmitter<{
  delta: [{ chatKey: string; text: string }]
  done: [{ chatKey: string; markdown: string; message: ChatMessage }]
  error: [{ chatKey: string; message: string }]
}> {
  /** One in-flight stream per thread; meeting chats and the global chat can overlap. */
  private active = new Map<string, AbortController>()

  async send(req: ChatSendRequest): Promise<{ ok: boolean; error?: string }> {
    const folderId = req.meetingId === null ? (req.folderId ?? null) : null
    const chatKey = chatKeyFor(req.meetingId, folderId)
    if (this.active.has(chatKey)) {
      return { ok: false, error: 'Still answering the previous question' }
    }
    const question = req.question.trim()
    if (!question) {
      return { ok: false, error: 'Ask a question first' }
    }
    const apiKey = getAnthropicKey()
    if (!apiKey) {
      return { ok: false, error: 'Anthropic API key not set — add it in Settings' }
    }

    // Reserve the thread before any await: context building is now async
    // (query embedding), and a second send racing past the has() check above
    // would double-stream and double-insert.
    const abort = new AbortController()
    this.active.set(chatKey, abort)
    try {
      return await this.prepare(req, chatKey, folderId, question, apiKey, abort)
    } catch (err) {
      this.active.delete(chatKey)
      throw err
    }
  }

  /** Builds context + history and starts the stream. The chatKey is already
   *  reserved; every error path must release it (handled by send's catch and
   *  the explicit deletes here). */
  private async prepare(
    req: ChatSendRequest,
    chatKey: string,
    folderId: string | null,
    question: string,
    apiKey: string,
    abort: AbortController
  ): Promise<{ ok: boolean; error?: string }> {
    let system: Anthropic.TextBlockParam[]
    let userTurn: string
    if (req.meetingId !== null) {
      const meeting = getMeeting(req.meetingId)
      if (!meeting) {
        this.active.delete(chatKey)
        return { ok: false, error: 'Meeting not found' }
      }
      system = [
        { type: 'text', text: CHAT_MEETING_SYSTEM, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: buildMeetingContext({
            meeting,
            segments: getSegments(req.meetingId),
            liveFinals: req.liveFinals
          }),
          cache_control: { type: 'ephemeral' }
        }
      ]
      userTurn = question
    } else if (folderId !== null) {
      const folder = getFolder(folderId)
      if (!folder) {
        this.active.delete(chatKey)
        return { ok: false, error: 'Folder not found' }
      }
      system = [{ type: 'text', text: CHAT_FOLDER_SYSTEM, cache_control: { type: 'ephemeral' } }]
      // Retrieval context (this folder's notes only) lives in the current turn.
      userTurn = await buildFolderContext(question, folderId, folder.name)
    } else {
      system = [{ type: 'text', text: CHAT_GLOBAL_SYSTEM, cache_control: { type: 'ephemeral' } }]
      // Retrieval context lives only in the current turn; history is replayed
      // as bare Q/A so stale excerpts never accumulate across turns.
      userTurn = await buildGlobalContext(question)
    }

    // History before this question's row, replayed as plain alternating turns.
    const history = getChatHistory(req.meetingId, folderId).map((m) => ({
      role: m.role,
      content: m.content
    }))
    insertChatMessage(req.meetingId, folderId, 'user', question)

    void this.run(apiKey, chatKey, req.meetingId, folderId, system, history, userTurn, abort)
    return { ok: true }
  }

  private async run(
    apiKey: string,
    chatKey: string,
    meetingId: string | null,
    folderId: string | null,
    system: Anthropic.TextBlockParam[],
    history: { role: 'user' | 'assistant'; content: string }[],
    userTurn: string,
    abort: AbortController
  ): Promise<void> {
    try {
      const client = new Anthropic({ apiKey })
      const stream = client.messages.stream(
        {
          model: getModel(),
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          system,
          messages: [...history, { role: 'user', content: userTurn }]
        },
        { signal: abort.signal }
      )

      let markdown = ''
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          markdown += event.delta.text
          this.emit('delta', { chatKey, text: event.delta.text })
        }
      }
      await stream.finalMessage()
      const message = insertChatMessage(meetingId, folderId, 'assistant', markdown)
      this.emit('done', { chatKey, markdown, message })
    } catch (err) {
      // The user row stays — history remains coherent for a retry.
      const message =
        err instanceof Anthropic.APIError
          ? `Anthropic API error ${err.status}: ${err.message}`
          : err instanceof Error && err.name === 'AbortError'
            ? 'Answer cancelled'
            : err instanceof Error
              ? err.message
              : String(err)
      this.emit('error', { chatKey, message })
    } finally {
      this.active.delete(chatKey)
    }
  }

  cancel(chatKey: string): void {
    this.active.get(chatKey)?.abort()
  }
}

export const chatService = new ChatService()
