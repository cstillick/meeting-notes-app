// Pure helpers for semantic retrieval: chunking, embedding carry-over, and
// vector math. No electron/db imports — unit-testable in plain Node.
import { formatTimestamp, speakerLabel, type TranscriptLine } from '../enhance/prompt'

/** The model every stored vector is produced by. Lives here (not in the
 *  embedder) so the db layer can stamp it on a row without importing network
 *  code — vectors from a different model are unusable and must be re-made. */
export const EMBED_MODEL = 'voyage-3.5-lite'

/** Chunk sizing: small enough that a chunk is one coherent topic, large enough
 *  that retrieval hits carry usable context. ~1.6K chars ≈ 400 tokens. */
const CHUNK_TARGET_CHARS = 1_600

/** Split one section of text into chunks by packing whole lines greedily.
 *  Deterministic and boundary-stable: text that only grows at the end (a
 *  transcript during recording) leaves earlier chunks byte-identical, so
 *  their embeddings survive the rebuild diff. */
function chunkSection(section: string): string[] {
  const chunks: string[] = []
  let current = ''
  const push = (): void => {
    const t = current.trim()
    if (t) chunks.push(t)
    current = ''
  }
  for (const line of section.split('\n')) {
    // A single line longer than the target is hard-split.
    if (line.length > CHUNK_TARGET_CHARS) {
      push()
      for (let i = 0; i < line.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(line.slice(i, i + CHUNK_TARGET_CHARS))
      }
      continue
    }
    if (current.length + line.length + 1 > CHUNK_TARGET_CHARS) push()
    current += (current ? '\n' : '') + line
  }
  push()
  return chunks
}

/** Chunk the transcript from its segments rather than from one space-joined
 *  string, so cuts land between speaker turns instead of mid-word. Attribution
 *  is carried by a single "[m:ss-m:ss]" header per chunk plus a "[Speaker]"
 *  label only where the speaker changes: per-line "[m:ss] [Speaker N] "
 *  prefixes would spend 20-30% of every chunk on repeated metadata. Packed in
 *  segment order, so a recording that only grows rewrites just the last chunk. */
function chunkTranscript(lines: TranscriptLine[]): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0
  let startMs = 0
  let endMs = 0
  let lastLabel = ''
  const push = (): void => {
    if (current.length === 0) return
    chunks.push(`[${formatTimestamp(startMs)}-${formatTimestamp(endMs)}]\n${current.join('\n')}`)
    current = []
    currentLen = 0
    lastLabel = ''
  }
  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    const label = speakerLabel(line)
    // Budget as if the label were always emitted: whether it actually is
    // depends on which chunk the line lands in, and that is what this decides.
    if (currentLen > 0 && currentLen + label.length + text.length + 4 > CHUNK_TARGET_CHARS) push()
    const rendered = label === lastLabel ? text : `[${label}] ${text}`
    // One segment over the whole target is pathological (a stuck ASR stream),
    // but an unbounded chunk would blow the embedding request, so hard-split it.
    if (rendered.length > CHUNK_TARGET_CHARS) {
      push()
      const stamp = formatTimestamp(line.startMs)
      for (let i = 0; i < rendered.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(`[${stamp}] ${rendered.slice(i, i + CHUNK_TARGET_CHARS)}`)
      }
      continue
    }
    if (current.length === 0) startMs = line.startMs
    endMs = line.startMs
    current.push(rendered)
    currentLen += rendered.length + 1
    lastLabel = label
  }
  push()
  return chunks
}

/** Chunk a note's text sources. Sections (rough notes, enhanced notes) and the
 *  transcript are chunked independently so an edit in one never moves another's
 *  chunk boundaries. Sections arrive line-structured (pmToPlainText / markdown),
 *  which is what makes the line-packing above cut on real boundaries. */
export function chunkNote(sections: string[], transcript: TranscriptLine[]): string[] {
  return [
    ...sections.filter((s) => s.trim()).flatMap(chunkSection),
    ...chunkTranscript(transcript)
  ]
}

/** Pair new chunk texts with embeddings carried over from the previous rows.
 *  Keyed by exact text (not seq), so unchanged chunks keep their embeddings
 *  even when edits shift their position. Vectors from another embedding model
 *  are dropped rather than carried — they are not comparable to today's queries.
 *  Changed/new chunks get null and are picked up by the background embedder. */
export function carryEmbeddings(
  prev: { text: string; embedding: Uint8Array | null; model: string | null }[],
  next: string[],
  model: string
): { text: string; embedding: Uint8Array | null }[] {
  const byText = new Map<string, Uint8Array>()
  for (const p of prev) {
    if (p.embedding && p.model === model && !byText.has(p.text)) byText.set(p.text, p.embedding)
  }
  return next.map((text) => ({ text, embedding: byText.get(text) ?? null }))
}

export function f32ToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer)
}

export function blobToF32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export interface ScoredChunk<T> {
  item: T
  score: number
}

/** Similarity a chunk must reach to count as a hit at all. Without a floor the
 *  top-k is always full: on a small library the tail of the list is unrelated
 *  text at near-zero similarity, which then enters RRF with real weight against
 *  the keyword ranking and — because a vector hit selects a note's excerpt —
 *  replaces that note's summary with an irrelevant passage. ~0.3 is the point
 *  where voyage-3.5-lite stops scoring merely-same-language prose. */
export const MIN_COSINE_SCORE = 0.3

/** Brute-force cosine top-k above MIN_COSINE_SCORE. At personal-library scale
 *  (thousands of chunks) this is single-digit milliseconds — no vector index
 *  needed. Vectors whose dimension doesn't match the query (stale rows from an
 *  embedding-model change) are skipped. */
export function cosineTopK<T>(
  query: Float32Array,
  candidates: { item: T; vector: Float32Array }[],
  k: number
): ScoredChunk<T>[] {
  const scored: ScoredChunk<T>[] = []
  for (const c of candidates) {
    if (c.vector.length !== query.length) continue
    const score = cosine(query, c.vector)
    if (score < MIN_COSINE_SCORE) continue
    scored.push({ item: c.item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/** Reciprocal Rank Fusion over ranked id lists (k=60, the standard constant).
 *  Returns ids ordered by fused score. Items missing from a list simply get no
 *  contribution from it. */
export function rrfMerge(rankings: string[][]): string[] {
  const K = 60
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}
