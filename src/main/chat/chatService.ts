// Streams Claude's answers to floating-chat questions, per thread.
// Opus 4.8+: no temperature/top_p/top_k (they 400); thinking config comes from
// the selected model's capabilities — adaptive is 4.6+ only.
import Anthropic from '@anthropic-ai/sdk'
import { EventEmitter } from 'events'
import {
  chatKeyFor,
  isRetryableApiStatus,
  thinkingParams,
  type ChatMessage,
  type ChatSendRequest,
  type ModelOption
} from '@shared/types'
import { getAnthropicKey, getModelCapabilities } from '../settings'
import { getMeeting } from '../db/meetings'
import { getFolder } from '../db/folders'
import { getSegments } from '../db/transcripts'
import { speakerNameMap } from '../db/speakers'
import { getChatHistory, insertChatMessage } from '../db/chats'
import { promptBudget } from '../enhance/prompt'
import {
  CHAT_FOLDER_SYSTEM,
  CHAT_GLOBAL_SYSTEM,
  CHAT_MEETING_SYSTEM,
  buildFolderContext,
  buildGlobalContext,
  buildMeetingContext
} from './prompt'

const MAX_TOKENS = 4096
/** The meeting context block is already huge, so replay fewer turns there than
 *  on the library paths, where the whole prompt is excerpts and index. */
const MEETING_HISTORY_LIMIT = 20
const LIBRARY_HISTORY_LIMIT = 40
/** Appended to an answer the model stopped mid-sentence, so the thread — and
 *  every later prompt that replays it — says so. */
const TRUNCATION_NOTE = '\n\n_[Answer cut off — the model hit its output limit.]_'

export class ChatService extends EventEmitter<{
  delta: [{ chatKey: string; text: string }]
  done: [{ chatKey: string; markdown: string; message: ChatMessage }]
  /** `retryable` marks the transient failures (429, 5xx/overloaded) that are
   *  worth an automatic backoff rather than a raw status string. */
  error: [{ chatKey: string; message: string; retryable: boolean }]
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
    // History before this question's row, replayed as plain alternating turns.
    const rows = getChatHistory(
      req.meetingId,
      folderId,
      req.meetingId !== null ? MEETING_HISTORY_LIMIT : LIBRARY_HISTORY_LIMIT
    )
    // A trailing user row is a question the model never answered — a failed
    // attempt left it behind. Retry re-asks it verbatim, so reuse that row
    // instead of inserting a second copy, and drop it from the replay either
    // way (the current turn carries the question).
    const last = rows[rows.length - 1]
    const duplicate = last?.role === 'user' && last.content === question
    while (rows.length > 0 && rows[rows.length - 1].role === 'user') rows.pop()
    const history = rows.map((m) => ({ role: m.role, content: m.content }))
    const historyChars = history.reduce((n, m) => n + m.content.length, 0)

    const caps = getModelCapabilities()
    let system: Anthropic.TextBlockParam[]
    let userTurn: string
    if (req.meetingId !== null) {
      const meeting = getMeeting(req.meetingId)
      if (!meeting) {
        this.active.delete(chatKey)
        return { ok: false, error: 'Meeting not found' }
      }
      system = [
        { type: 'text', text: CHAT_MEETING_SYSTEM },
        {
          type: 'text',
          text: buildMeetingContext({
            meeting,
            segments: getSegments(req.meetingId),
            liveFinals: req.liveFinals,
            names: speakerNameMap(req.meetingId),
            budget: promptBudget(caps, historyChars + CHAT_MEETING_SYSTEM.length)
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
      // The folder's meeting index is identical across turns, so it rides in a
      // second system block (and pushes the prefix past the 1024-token minimum
      // cacheable size, which CHAT_FOLDER_SYSTEM alone is well under). Volatile
      // excerpts stay in the current turn so stale ones never accumulate.
      const ctx = await buildFolderContext(
        question,
        folderId,
        folder.name,
        promptBudget(caps, historyChars + CHAT_FOLDER_SYSTEM.length)
      )
      system = [
        { type: 'text', text: CHAT_FOLDER_SYSTEM },
        { type: 'text', text: ctx.system, cache_control: { type: 'ephemeral' } }
      ]
      userTurn = ctx.userTurn
    } else {
      const ctx = await buildGlobalContext(
        question,
        promptBudget(caps, historyChars + CHAT_GLOBAL_SYSTEM.length)
      )
      system = [
        { type: 'text', text: CHAT_GLOBAL_SYSTEM },
        { type: 'text', text: ctx.system, cache_control: { type: 'ephemeral' } }
      ]
      userTurn = ctx.userTurn
    }

    if (!duplicate) insertChatMessage(req.meetingId, folderId, 'user', question)

    void this.run(apiKey, caps, chatKey, req.meetingId, folderId, system, history, userTurn, abort)
    return { ok: true }
  }

  private async run(
    apiKey: string,
    caps: ModelOption,
    chatKey: string,
    meetingId: string | null,
    folderId: string | null,
    system: Anthropic.TextBlockParam[],
    history: { role: 'user' | 'assistant'; content: string }[],
    userTurn: string,
    abort: AbortController
  ): Promise<void> {
    try {
      // History is a strictly-appending stable prefix — the pattern caching
      // exists for. Marking its last block caches system + every earlier turn,
      // which on the folder and global paths is the only breakpoint that ever
      // fires (their system prompt alone is well under the 1024-token minimum).
      const messages: Anthropic.MessageParam[] = history.map((m, i) =>
        i === history.length - 1
          ? {
              role: m.role,
              content: [
                { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } } as const
              ]
            }
          : { role: m.role, content: m.content }
      )
      messages.push({ role: 'user', content: userTurn })

      const client = new Anthropic({ apiKey })
      const stream = client.messages.stream(
        {
          model: caps.id,
          max_tokens: MAX_TOKENS,
          ...thinkingParams(caps),
          system,
          messages
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
      const final = await stream.finalMessage()
      // A refusal is HTTP 200 with stop_reason 'refusal', and it can follow
      // partial text — so the stop reason decides, not the accumulated string.
      // Nothing is persisted either way: an empty or refused assistant row is
      // replayed into every later turn of this thread and 400s the send.
      if (final.stop_reason === 'refusal') {
        this.emit('error', {
          chatKey,
          message: 'Claude declined to answer that question.',
          retryable: false
        })
        return
      }
      if (!markdown.trim()) {
        this.emit('error', {
          chatKey,
          message: 'Claude returned an empty answer — try rephrasing the question.',
          retryable: false
        })
        return
      }
      const answer = final.stop_reason === 'max_tokens' ? markdown + TRUNCATION_NOTE : markdown
      const message = insertChatMessage(meetingId, folderId, 'assistant', answer)
      this.emit('done', { chatKey, markdown: answer, message })
    } catch (err) {
      // The user row stays — history remains coherent, and prepare() reuses it
      // on a retry instead of inserting a second copy of the same question.
      const retryable = err instanceof Anthropic.APIError && isRetryableApiStatus(err.status)
      const message =
        err instanceof Anthropic.APIError
          ? retryable
            ? `Claude is busy right now (${err.status}) — try again in a moment.`
            : `Anthropic API error ${err.status}: ${err.message}`
          : err instanceof Error && err.name === 'AbortError'
            ? 'Answer cancelled'
            : err instanceof Error
              ? err.message
              : String(err)
      this.emit('error', { chatKey, message, retryable })
    } finally {
      this.active.delete(chatKey)
    }
  }

  cancel(chatKey: string): void {
    this.active.get(chatKey)?.abort()
  }
}

export const chatService = new ChatService()
