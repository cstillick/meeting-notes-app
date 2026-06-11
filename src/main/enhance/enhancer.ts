// Streams Claude's enhanced-notes markdown to the renderer.
// Opus 4.8+: no temperature/top_p/top_k (they 400); adaptive thinking on.
import Anthropic from '@anthropic-ai/sdk'
import { EventEmitter } from 'events'
import { getAnthropicKey, getModel } from '../settings'
import { getMeeting, updateStatus } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { SYSTEM_PROMPT, buildUserMessage } from './prompt'

export class Enhancer extends EventEmitter<{
  delta: [{ meetingId: string; text: string }]
  done: [{ meetingId: string; markdown: string }]
  error: [{ meetingId: string; message: string }]
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
    try {
      const client = new Anthropic({ apiKey })
      const stream = client.messages.stream(
        {
          model: getModel(),
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
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
                segments
              })
            }
          ]
        },
        { signal: this.abort?.signal }
      )

      let markdown = ''
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          markdown += event.delta.text
          this.emit('delta', { meetingId, text: event.delta.text })
        }
      }
      await stream.finalMessage()
      this.emit('done', { meetingId, markdown })
    } catch (err) {
      const message =
        err instanceof Anthropic.APIError
          ? `Anthropic API error ${err.status}: ${err.message}`
          : err instanceof Error && err.name === 'AbortError'
            ? 'Enhancement cancelled'
            : err instanceof Error
              ? err.message
              : String(err)
      // Restore what the meeting was before (a failed re-enhance must not
      // downgrade an already-enhanced meeting to 'recorded').
      updateStatus(meetingId, previousStatus === 'enhancing' ? 'recorded' : previousStatus)
      this.emit('error', { meetingId, message })
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
