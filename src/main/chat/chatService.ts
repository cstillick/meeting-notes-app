// Streams Claude's answers to floating-chat questions, per thread.
// Opus 4.8+: no temperature/top_p/top_k (they 400); adaptive thinking on.
import Anthropic from '@anthropic-ai/sdk'
import { EventEmitter } from 'events'
import type { ChatMessage, ChatSendRequest } from '@shared/types'
import { getAnthropicKey, getModel } from '../settings'
import { getMeeting } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { getChatHistory, insertChatMessage } from '../db/chats'
import {
  CHAT_GLOBAL_SYSTEM,
  CHAT_MEETING_SYSTEM,
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

  send(req: ChatSendRequest): { ok: boolean; error?: string } {
    const chatKey = req.meetingId ?? 'global'
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

    let system: Anthropic.TextBlockParam[]
    let userTurn: string
    if (req.meetingId !== null) {
      const meeting = getMeeting(req.meetingId)
      if (!meeting) {
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
    } else {
      system = [{ type: 'text', text: CHAT_GLOBAL_SYSTEM, cache_control: { type: 'ephemeral' } }]
      // Retrieval context lives only in the current turn; history is replayed
      // as bare Q/A so stale excerpts never accumulate across turns.
      userTurn = buildGlobalContext(question)
    }

    // History before this question's row, replayed as plain alternating turns.
    const history = getChatHistory(req.meetingId).map((m) => ({
      role: m.role,
      content: m.content
    }))
    insertChatMessage(req.meetingId, 'user', question)

    const abort = new AbortController()
    this.active.set(chatKey, abort)
    void this.run(apiKey, chatKey, req.meetingId, system, history, userTurn, abort)
    return { ok: true }
  }

  private async run(
    apiKey: string,
    chatKey: string,
    meetingId: string | null,
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
      const message = insertChatMessage(meetingId, 'assistant', markdown)
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
