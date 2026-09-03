// Streams Claude's enhanced-notes markdown to the renderer.
// Opus 4.8+: no temperature/top_p/top_k (they 400); thinking config comes from
// the selected model's capabilities — adaptive is 4.6+ only.
import Anthropic from '@anthropic-ai/sdk'
import { EventEmitter } from 'events'
import { isRetryableApiStatus, thinkingParams } from '@shared/types'
import { getAnthropicKey, getModelCapabilities } from '../settings'
import { getMeeting, hasEnhancement, updateStatus } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { speakerNameMap } from '../db/speakers'
import { SYSTEM_PROMPT, TRUNCATION_NOTE, buildUserMessage, promptBudget } from './prompt'

/** Thinking tokens and the answer share this cap, so a long meeting can stop
 *  mid-sentence at `stop_reason: 'max_tokens'` — handled below rather than
 *  saved as if it were a finished document. */
const MAX_TOKENS = 16000

export class Enhancer extends EventEmitter<{
  delta: [{ meetingId: string; text: string }]
  done: [{ meetingId: string; markdown: string }]
  /** `retryable` marks the transient failures (429, 5xx/overloaded) worth an
   *  automatic backoff; `partial` carries whatever streamed before a mid-flight
   *  failure so the renderer can offer to keep it rather than discarding
   *  minutes of paid output. */
  error: [{ meetingId: string; message: string; retryable: boolean; partial?: string }]
}> {
  private abort: AbortController | null = null
  private activeMeetingId: string | null = null

  start(meetingId: string): { ok: boolean; error?: string } {
    if (this.activeMeetingId) {
      return { ok: false, error: 'An enhancement is already running' }
    }
    const apiKey = getAnthropicKey()
    if (!apiKey) {
      return { ok: false, error: 'Anthropic API key not set — add it in Settings' }
    }
    const meeting = getMeeting(meetingId)
    if (!meeting) {
      return { ok: false, error: 'Meeting not found' }
    }
    const segments = getSegments(meetingId)
    if (segments.length === 0) {
      return { ok: false, error: 'No transcript yet — record the meeting first' }
    }

    this.activeMeetingId = meetingId
    this.abort = new AbortController()
    const previousStatus = meeting.status
    updateStatus(meetingId, 'enhancing')
    void this.run(apiKey, meetingId, meeting, segments, previousStatus)
    return { ok: true }
  }

  private async run(
    apiKey: string,
    meetingId: string,
    meeting: NonNullable<ReturnType<typeof getMeeting>>,
    segments: ReturnType<typeof getSegments>,
    previousStatus: NonNullable<ReturnType<typeof getMeeting>>['status']
  ): Promise<void> {
    let markdown = ''
    try {
      const caps = getModelCapabilities()
      const client = new Anthropic({ apiKey })
      const stream = client.messages.stream(
        {
          model: caps.id,
          max_tokens: MAX_TOKENS,
          ...thinkingParams(caps),
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
          ],
          messages: [
            {
              role: 'user',
              content: buildUserMessage({
                title: meeting.title,
                startedAt: meeting.startedAt,
                notesJson: meeting.notesJson,
                segments,
                names: speakerNameMap(meetingId),
                budget: promptBudget(caps, SYSTEM_PROMPT.length)
              })
            }
          ]
        },
        { signal: this.abort?.signal }
      )

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          markdown += event.delta.text
          this.emit('delta', { meetingId, text: event.delta.text })
        }
      }
      const final = await stream.finalMessage()
      // A refusal is HTTP 200 with stop_reason 'refusal', and it can follow
      // partial text — so the stop reason decides, not the accumulated string,
      // which is only a backstop for a silent zero-content success. Throwing
      // (rather than emitting 'error' here) keeps the catch below as the single
      // place that restores the status; branching around it would strand the
      // meeting at 'enhancing' forever.
      if (final.stop_reason === 'refusal') {
        throw new Error('Claude declined to enhance these notes.')
      }
      if (!markdown.trim()) {
        throw new Error('Claude returned an empty enhancement.')
      }
      if (final.stop_reason === 'max_tokens') {
        // The renderer saves whatever `done` carries, and enhanced notes are
        // hand-editable — so a cut-off re-run must never replace a finished
        // document. A first enhancement is worth keeping, marked as cut off.
        if (hasEnhancement(meetingId)) {
          throw new Error(
            'Claude hit its output limit before finishing. The existing enhanced notes were left untouched — try again.'
          )
        }
        this.emit('done', { meetingId, markdown: `${markdown}\n\n${TRUNCATION_NOTE}` })
        return
      }
      this.emit('done', { meetingId, markdown })
    } catch (err) {
      const retryable = err instanceof Anthropic.APIError && isRetryableApiStatus(err.status)
      const message =
        err instanceof Anthropic.APIError
          ? retryable
            ? `Claude is busy right now (${err.status}) — try again in a moment.`
            : `Anthropic API error ${err.status}: ${err.message}`
          : err instanceof Error && err.name === 'AbortError'
            ? 'Enhancement cancelled'
            : err instanceof Error
              ? err.message
              : String(err)
      // Restore what the meeting was before (a failed re-enhance must not
      // downgrade an already-enhanced meeting to 'recorded').
      updateStatus(meetingId, previousStatus === 'enhancing' ? 'recorded' : previousStatus)
      this.emit('error', { meetingId, message, retryable, partial: markdown || undefined })
    } finally {
      this.activeMeetingId = null
      this.abort = null
    }
  }

  cancel(): void {
    this.abort?.abort()
  }
}

export const enhancer = new Enhancer()
