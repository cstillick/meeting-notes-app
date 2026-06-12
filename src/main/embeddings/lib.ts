// Pure helpers for semantic retrieval: chunking, embedding carry-over, and
// vector math. No electron/db imports — unit-testable in plain Node.

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

/** Chunk a note's text sources. Sections (rough notes, enhanced notes,
 *  transcript) are chunked independently so an edit in one never moves
 *  another's chunk boundaries. */
export function chunkSections(sections: string[]): string[] {
  return sections.filter((s) => s.trim()).flatMap(chunkSection)
}

/** Pair new chunk texts with embeddings carried over from the previous rows.
 *  Keyed by exact text (not seq), so unchanged chunks keep their embeddings
 *  even when edits shift their position. Changed/new chunks get null and are
 *  picked up by the background embedder. */
export function carryEmbeddings(
  prev: { text: string; embedding: Uint8Array | null }[],
  next: string[]
): { text: string; embedding: Uint8Array | null }[] {
  const byText = new Map<string, Uint8Array>()
  for (const p of prev) {
    if (p.embedding && !byText.has(p.text)) byText.set(p.text, p.embedding)
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

/** Brute-force cosine top-k. At personal-library scale (thousands of chunks)
 *  this is single-digit milliseconds — no vector index needed. Vectors whose
 *  dimension doesn't match the query (stale rows from an embedding-model
 *  change) are skipped. */
export function cosineTopK<T>(
  query: Float32Array,
  candidates: { item: T; vector: Float32Array }[],
  k: number
): ScoredChunk<T>[] {
  const scored: ScoredChunk<T>[] = []
  for (const c of candidates) {
    if (c.vector.length !== query.length) continue
    scored.push({ item: c.item, score: cosine(query, c.vector) })
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
