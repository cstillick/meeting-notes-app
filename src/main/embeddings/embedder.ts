// Background embedding pipeline + semantic search for cross-note chat.
// Anthropic has no embeddings API; Voyage AI is their recommended provider.
// Everything here degrades gracefully: with no Voyage key (or on any API
// failure) chunks simply stay unembedded and chat falls back to keyword-only
// retrieval — exactly the pre-RAG behavior.
import { getVoyageKey } from '../settings'
import {
  listEmbeddedChunks,
  listUnembeddedChunks,
  listUnchunkedMeetingIds,
  saveChunkEmbedding
} from '../db/chunks'
import { setOnReindexed, reindexMeeting } from '../db/search'
import { blobToF32, cosineTopK, f32ToBlob } from './lib'

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3.5-lite'
/** Voyage accepts up to 128 inputs per request. */
const EMBED_BATCH = 64
/** Saves coalesce during typing; wait for a quiet moment before embedding. */
const EMBED_DEBOUNCE_MS = 3_000

async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query',
  apiKey: string
): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType })
  })
  if (!res.ok) {
    throw new Error(`Voyage API error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] }
  // Order is documented to match input order, but index is authoritative.
  const out: number[][] = new Array(texts.length)
  for (const d of json.data) out[d.index] = d.embedding
  return out
}

let timer: NodeJS.Timeout | null = null
let draining = false

/** Embed every NULL-embedding chunk, batched, until none remain. Serial and
 *  self-deduplicating: schedule calls during a drain just queue another pass. */
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    const apiKey = getVoyageKey()
    if (!apiKey) return
    for (;;) {
      const batch = listUnembeddedChunks(EMBED_BATCH)
      if (batch.length === 0) return
      const vectors = await embedTexts(
        batch.map((c) => c.text),
        'document',
        apiKey
      )
      batch.forEach((c, i) => {
        if (vectors[i]) saveChunkEmbedding(c.id, f32ToBlob(vectors[i]))
      })
    }
  } catch (err) {
    // Leave the rest unembedded; the next save/launch retries.
    console.error('embedder: drain failed', err)
  } finally {
    draining = false
  }
}

/** Debounced kick — called after any reindex and when a Voyage key is saved. */
export function scheduleEmbed(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void drain()
  }, EMBED_DEBOUNCE_MS)
}

/** Wire the pipeline: chunk rebuilds ride along with every FTS reindex (hook
 *  set here), then chunk + embed whatever already exists. Called once at startup. */
export function initEmbedder(): void {
  setOnReindexed(() => scheduleEmbed())
  setImmediate(() => {
    try {
      // Notes from before the chunks table existed: reindex chunks them.
      for (const id of listUnchunkedMeetingIds()) reindexMeeting(id)
    } catch (err) {
      console.error('embedder: chunk backfill failed', err)
    }
    scheduleEmbed()
  })
}

export interface ChunkHit {
  meetingId: string
  seq: number
  text: string
  score: number
}

/** Semantic top-k chunks for a question, scoped to a folder or the whole
 *  library. Returns [] when no Voyage key is set or the API fails — callers
 *  treat vector search as an optional enhancement over keyword search. */
export async function searchChunks(
  question: string,
  folderId: string | null,
  k: number
): Promise<ChunkHit[]> {
  const apiKey = getVoyageKey()
  if (!apiKey) return []
  try {
    const [queryVec] = await embedTexts([question], 'query', apiKey)
    const query = new Float32Array(queryVec)
    const candidates = listEmbeddedChunks(folderId).map((c) => ({
      item: c,
      vector: blobToF32(c.embedding!)
    }))
    return cosineTopK(query, candidates, k).map(({ item, score }) => ({
      meetingId: item.meeting_id,
      seq: item.seq,
      text: item.text,
      score
    }))
  } catch (err) {
    console.error('embedder: semantic search failed, falling back to keyword-only', err)
    return []
  }
}
