// Propose speaker names from the transcript's own words.
//
// This is the only speaker *identification* that can exist here: Deepgram has
// no enrollment API, no voiceprints and no exposed embeddings, so a voice can
// only be named from what is said — a self-introduction ("Hi, I'm Dana"),
// someone being addressed by name, or a role the content makes obvious. In a
// lecture the professor almost always names themselves in the first minute,
// which turns five manual renames into one confirmation.
//
// Nothing here writes. The handler returns proposals and the user accepts them
// one by one, because a confidently wrong name is worse than "Speaker 2": it
// propagates silently into the enhanced notes, chat answers and every export.
import Anthropic from '@anthropic-ai/sdk'
import type { Channel, SpeakerIdentity } from '@shared/types'
import { getAnthropicKey } from '../settings'
import { getMeeting } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { speakerRoster } from '../db/speakers'
import { defaultSpeakerLabel, formatTimestamp } from '../enhance/prompt'

// A high-volume classification task, not a writing task — same reasoning as the
// knowledge-graph extractor, which also pins Haiku regardless of the user's
// chat/enhance model choice.
const IDENTIFY_MODEL = 'claude-haiku-4-5-20251001'
/** Introductions live at the start. Spend most of the budget there, then a
 *  sample of each voice's longest turn so a late-joining speaker is still
 *  reachable. */
const OPENING_CHARS = 9_000
const SAMPLE_CHARS = 3_000
/** Below this there is nothing to go on and a guess would be pure invention. */
const MIN_TRANSCRIPT_CHARS = 200

export interface SpeakerSuggestion {
  channel: Channel
  speaker: number
  name: string
  /** The phrase in the transcript that justifies the name — shown to the user,
   *  so a hallucinated name is visibly unsupported rather than plausible. */
  reason: string
  confidence: number
}

const SYSTEM = `You label the distinct voices in a transcript. You will see a transcript whose speakers are anonymous labels ("Speaker 1", "Me", "Speaker 2 (room)"), and a list of those labels.

Rules:
- Propose a real personal name ONLY when the transcript states it: someone introduces themselves, someone is addressed by name, or a name is otherwise clearly attached to that voice. Quote the exact phrase that justifies it in "reason".
- When no name is stated, propose a ROLE that the content makes obvious — "Professor", "Student", "Interviewer", "Client", "Host" — and say in "reason" what makes that role clear.
- NEVER invent a name. If you cannot support either a name or a role, omit that speaker entirely. Omitting is always correct; guessing is not.
- confidence is 0 to 1: how sure you are this label belongs to this voice. A name someone stated about THEMSELVES is high; a name you inferred from who replied to whom is low.
- is_me: true only when the transcript makes it explicit that this voice is the person taking the notes. In a lecture the dominant voice is usually the presenter, NOT the note-taker — do not assume the loudest speaker is the user.
- Return the label exactly as it appeared in the input so it can be matched back.`

const TOOL: Anthropic.Tool = {
  name: 'name_speakers',
  description: 'Propose a name or role for each voice the transcript identifies.',
  input_schema: {
    type: 'object',
    properties: {
      speakers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The anonymous label, copied exactly' },
            name: { type: 'string', description: 'Proposed personal name or role' },
            reason: { type: 'string', description: 'The transcript phrase that justifies it' },
            confidence: { type: 'number' },
            is_me: { type: 'boolean' }
          },
          required: ['label', 'name', 'reason', 'confidence']
        }
      }
    },
    required: ['speakers']
  }
}

/** Transcript text weighted toward the opening, plus each voice's longest turn.
 *  Rendered with the DEFAULT labels — the model must reason about anonymous
 *  voices, not be handed names the user already assigned. */
function identificationText(meetingId: string, roster: SpeakerIdentity[]): string {
  const segments = getSegments(meetingId)
  const line = (s: (typeof segments)[number]): string =>
    `[${formatTimestamp(s.startMs)}] [${defaultSpeakerLabel(s.channel, s.speaker)}] ${s.text}`

  const opening: string[] = []
  let used = 0
  for (const s of segments) {
    const rendered = line(s)
    if (used + rendered.length > OPENING_CHARS) break
    opening.push(rendered)
    used += rendered.length + 1
  }

  // One long turn per voice, so someone who only speaks at minute 50 is still
  // represented — the opening slice alone would never reach them.
  const longest = new Map<string, (typeof segments)[number]>()
  for (const s of segments) {
    const key = `${s.channel}:${s.speaker ?? -1}`
    const best = longest.get(key)
    if (!best || s.text.length > best.text.length) longest.set(key, s)
  }
  const samples: string[] = []
  let sampleUsed = 0
  for (const s of longest.values()) {
    const rendered = line(s)
    if (sampleUsed + rendered.length > SAMPLE_CHARS) break
    samples.push(rendered)
    sampleUsed += rendered.length + 1
  }

  const labels = roster.map((r) => defaultSpeakerLabel(r.channel, r.speaker)).join(', ')
  return [
    `<voices>\n${labels}\n</voices>`,
    `<opening>\n${opening.join('\n')}\n</opening>`,
    `<samples>\n${samples.join('\n')}\n</samples>`
  ].join('\n\n')
}

/** Proposals for one note. Throws with a user-readable message; the IPC handler
 *  turns that into `{ ok: false, error }` rather than a rejected promise. */
export async function suggestSpeakers(meetingId: string): Promise<SpeakerSuggestion[]> {
  const apiKey = getAnthropicKey()
  if (!apiKey) throw new Error('Anthropic API key not set — add it in Settings')
  if (!getMeeting(meetingId)) throw new Error('Note not found')

  const roster = speakerRoster(meetingId)
  if (roster.length === 0) throw new Error('This note has no transcript yet')

  const text = identificationText(meetingId, roster)
  if (text.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error('Not enough transcript yet to identify anyone')
  }

  // Match a returned label back to the key it came from. The model echoes the
  // label rather than a channel/index pair, which keeps the tool schema simple
  // and is unambiguous because default labels are unique per note.
  const byLabel = new Map<string, SpeakerIdentity>()
  for (const r of roster) byLabel.set(defaultSpeakerLabel(r.channel, r.speaker), r)

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: IDENTIFY_MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'name_speakers' },
    messages: [{ role: 'user', content: text }]
  })
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'name_speakers'
  )
  if (!toolUse) throw new Error('The model returned no suggestions')

  const raw = (toolUse.input as { speakers?: unknown }).speakers
  const out: SpeakerSuggestion[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const s = item as { label?: unknown; name?: unknown; reason?: unknown; confidence?: unknown }
    if (typeof s.label !== 'string' || typeof s.name !== 'string') continue
    const match = byLabel.get(s.label)
    // A label that matches nothing is a hallucinated voice; drop it rather than
    // inventing a key for it.
    if (!match) continue
    const name = s.name.trim().slice(0, 60)
    if (!name) continue
    out.push({
      channel: match.channel,
      // -1 is the undiarized sentinel the roster tables key on, so an
      // undiarized "Me"/"Them" is nameable exactly like a diarized voice.
      speaker: match.speaker ?? -1,
      name,
      reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : '',
      confidence: typeof s.confidence === 'number' ? s.confidence : 0
    })
  }
  return out
}
