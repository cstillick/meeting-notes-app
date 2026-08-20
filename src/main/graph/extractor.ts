// Background entity extraction for the knowledge graph.
//
// Mirrors the embedder's shape: a debounced serial drain over notes whose
// entities_at is NULL, degrading gracefully — no Anthropic key, no network,
// no problem: notes just wait, and the next save or launch retries. Extraction
// runs on Haiku regardless of the user's chat/enhance model choice: it is a
// high-volume background classification task, not a writing task.
import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicKey } from '../settings'
import { getMeeting } from '../db/meetings'
import { getSegments } from '../db/transcripts'
import { pmToPlainText } from '../enhance/prompt'
import {
  listUnextractedMeetingIds,
  saveNoteEntities,
  type ExtractedEntity
} from '../db/entities'
import { broadcast } from '../ipc'

const EXTRACT_MODEL = 'claude-haiku-4-5-20251001'
const EXTRACT_DEBOUNCE_MS = 4_000
const DRAIN_BATCH = 20
/** Notes with less text than this get an empty extraction (stamped, so the
 *  drain converges) — there is nothing to graph in a two-line stub. */
const MIN_TEXT_CHARS = 120
const MAX_TEXT_CHARS = 12_000

const SYSTEM = `You extract a knowledge graph from one note (meeting notes, a lecture, a reading, or research). Identify the entities the note is substantively about.

Rules:
- 4 to 12 entities. Fewer is better than padding with trivia.
- kind "concept" for ideas, theories, methods, and subjects (e.g. "Fiscal Multiplier", "Sticky Prices"); "person" for people; "organization" for companies, institutions, teams; "topic" for broad subject areas that group many concepts (e.g. "Macroeconomics").
- Canonical, reusable names: singular, Title Case, no articles, so the same idea gets the same name across different notes. "IS-LM Model", not "the IS-LM model we discussed".
- salience is how central the entity is to THIS note, 0 to 1. A passing mention is below 0.3 — usually omit it.
- Never invent entities that are not in the text. Never use generic labels like "Meeting", "Notes", "Discussion", "Action Items".`

const TOOL: Anthropic.Tool = {
  name: 'record_entities',
  description: 'Record the entities this note is about.',
  input_schema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', enum: ['concept', 'person', 'organization', 'topic'] },
            salience: { type: 'number' }
          },
          required: ['name', 'kind', 'salience']
        }
      }
    },
    required: ['entities']
  }
}

/** The best text for extraction: enhanced notes (sentinels stripped), else
 *  rough notes plus the transcript head. Capped — extraction reads themes,
 *  not every word. */
function extractionText(meetingId: string): string | null {
  const meeting = getMeeting(meetingId)
  if (!meeting) return null
  const parts: string[] = [meeting.title]
  if (meeting.enhancedMd) {
    parts.push(meeting.enhancedMd.replace(/[⟦⟧]\/?U[⟦⟧]/g, '').replace(/[⟦⟧]/g, ''))
  } else {
    parts.push(pmToPlainText(meeting.notesJson))
    const transcript = getSegments(meetingId)
      .map((s) => s.text)
      .join(' ')
    parts.push(transcript)
  }
  return parts.filter(Boolean).join('\n\n').slice(0, MAX_TEXT_CHARS)
}

async function extractOne(apiKey: string, meetingId: string): Promise<boolean> {
  const text = extractionText(meetingId)
  if (text === null) return false // note vanished; nothing to stamp
  if (text.length < MIN_TEXT_CHARS) {
    saveNoteEntities(meetingId, [])
    return true
  }
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'record_entities' },
    messages: [{ role: 'user', content: `<note>\n${text}\n</note>` }]
  })
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_entities'
  )
  if (!toolUse) throw new Error('extractor: model returned no tool call')
  const raw = (toolUse.input as { entities?: unknown }).entities
  const entities: ExtractedEntity[] = (Array.isArray(raw) ? raw : [])
    .filter(
      (e): e is { name: string; kind: string; salience: number } =>
        !!e &&
        typeof (e as { name?: unknown }).name === 'string' &&
        typeof (e as { salience?: unknown }).salience === 'number'
    )
    .map((e) => ({
      name: e.name.slice(0, 120),
      kind: (['concept', 'person', 'organization', 'topic'] as const).includes(
        e.kind as 'concept'
      )
        ? (e.kind as ExtractedEntity['kind'])
        : 'concept',
      weight: e.salience
    }))
    .filter((e) => e.weight >= 0.2)
    .slice(0, 16)
  saveNoteEntities(meetingId, entities)
  return true
}

let timer: NodeJS.Timeout | null = null
let draining = false

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  let extractedAny = false
  try {
    const apiKey = getAnthropicKey()
    if (!apiKey) return
    for (;;) {
      const batch = listUnextractedMeetingIds(DRAIN_BATCH)
      if (batch.length === 0) break
      let progressed = false
      for (const id of batch) {
        try {
          if (await extractOne(apiKey, id)) {
            progressed = true
            extractedAny = true
          }
        } catch (err) {
          // Leave this note unstamped and stop the pass — a 429/5xx would
          // otherwise fail the whole backlog one note at a time.
          console.error('extractor: failed on', id, err)
          return
        }
      }
      // A batch of vanished notes stamps nothing; don't spin on it.
      if (!progressed) break
    }
  } finally {
    draining = false
    if (extractedAny) broadcast('graph:changed')
  }
}

/** Debounced kick — after enhancement, import, recording stop, MCP writes. */
export function scheduleExtract(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void drain()
  }, EXTRACT_DEBOUNCE_MS)
}

/** Startup: drain whatever is missing (first run: the whole library). */
export function initExtractor(): void {
  setImmediate(() => scheduleExtract())
}
