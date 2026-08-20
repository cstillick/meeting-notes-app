// Cross-channel echo detection. Without headphones, audio another app plays
// (Zoom, YouTube) reaches the mic acoustically — Chromium's echo cancellation
// only cancels audio Chromium itself plays — so remote speech gets transcribed
// on BOTH channels and shows up as "Me" and "Them" at once. The system channel
// is canonical for remote audio: a mic segment that duplicates overlapping
// system speech is an echo and should be dropped.
//
// Matching is text+time based: token coverage of the mic text against the
// union of system tokens in the overlapping window. Both channels anchor
// their timelines to their first audio chunk (see DeepgramSession), so a
// small time tolerance covers Deepgram jitter.

export interface EchoSuppressorOptions {
  /** How long system entries are retained for matching. */
  windowMs?: number
  /** Time slack around the mic segment when selecting system entries. */
  toleranceMs?: number
  /** Mic texts with fewer tokens skip the coverage gate ("yeah", "okay") and
   *  are only suppressed as embedded fragments of one long system entry. */
  minTokens?: number
  /** Fraction of mic tokens that must appear in ONE overlapping system entry. */
  coverage?: number
}

const DEFAULT_WINDOW_MS = 15000
const DEFAULT_TOLERANCE_MS = 2000
const DEFAULT_MIN_TOKENS = 3
const DEFAULT_COVERAGE = 0.75

interface SystemEntry {
  startMs: number
  endMs: number
  tokens: Set<string>
  /** Original word order, for the contiguous-bigram check. */
  seq: string[]
}

/** Full match diagnostics — lets the recorder log why a decision was made. */
export interface EchoVerdict {
  isEcho: boolean
  micTokenCount: number
  /** Best fraction of mic tokens found in ONE overlapping system utterance
   *  (or two adjacent ones, for a mic final that straddles a system boundary). */
  coverage: number
  /** Distinct system tokens inside the mic segment's tolerance window. */
  unionSize: number
  /** Retained system entries at decision time. */
  entryCount: number
  /** start delta (system − mic) of the closest entry by start, null if none.
   *  Large |delta| with low unionSize = cross-channel timeline skew. */
  nearestStartDeltaMs: number | null
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
}

function coverageOf(micTokens: string[], tokens: Set<string>): number {
  if (micTokens.length === 0) return 0
  let hits = 0
  for (const t of micTokens) {
    if (tokens.has(t)) hits++
  }
  return hits / micTokens.length
}

/** True if any two adjacent mic words appear adjacent, in that order, in seq. */
function sharesBigram(micTokens: string[], seq: string[]): boolean {
  for (let i = 0; i + 1 < micTokens.length; i++) {
    for (let j = 0; j + 1 < seq.length; j++) {
      if (seq[j] === micTokens[i] && seq[j + 1] === micTokens[i + 1]) return true
    }
  }
  return false
}

export class EchoSuppressor {
  private readonly windowMs: number
  private readonly toleranceMs: number
  private readonly minTokens: number
  private readonly coverage: number
  private entries: SystemEntry[] = []

  constructor(opts: EchoSuppressorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS
    this.minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
    this.coverage = opts.coverage ?? DEFAULT_COVERAGE
  }

  /** Feed every system result — interims included, since they arrive seconds
   *  before finals and let echoes resolve early. Set-based matching makes
   *  overlapping interim revisions harmless. */
  observeSystem(text: string, startMs: number, endMs: number): void {
    const seq = tokenize(text)
    if (seq.length === 0) return
    this.entries.push({ startMs, endMs, tokens: new Set(seq), seq })
    const cutoff = endMs - this.windowMs
    while (this.entries.length > 0 && this.entries[0].endMs < cutoff) {
      this.entries.shift()
    }
  }

  /** True if this mic text duplicates recent, time-overlapping system speech. */
  isEcho(text: string, startMs: number, endMs: number): boolean {
    return this.evaluate(text, startMs, endMs).isEcho
  }

  /** isEcho plus the intermediate numbers, for instrumentation (ECHO_DEBUG). */
  evaluate(text: string, startMs: number, endMs: number): EchoVerdict {
    const micTokens = tokenize(text)
    const lo = startMs - this.toleranceMs
    const hi = endMs + this.toleranceMs
    const systemUnion = new Set<string>()
    const overlapping: SystemEntry[] = []
    let nearestStartDeltaMs: number | null = null
    for (const e of this.entries) {
      const delta = e.startMs - startMs
      if (nearestStartDeltaMs === null || Math.abs(delta) < Math.abs(nearestStartDeltaMs)) {
        nearestStartDeltaMs = delta
      }
      if (e.startMs <= hi && e.endMs >= lo) {
        overlapping.push(e)
        for (const t of e.tokens) systemUnion.add(t)
      }
    }

    // Coverage is measured against the MIC tokens, but only ever against ONE
    // system utterance (or two adjacent ones, for a mic final that straddles a
    // system boundary) — never the whole window union. That union holds several
    // seconds of remote vocabulary, enough common words to "cover" a genuine
    // backchannel like "yeah that sounds good" said while the other party talks,
    // and a false positive here discards the user's own speech permanently.
    const utterances = this.mergeInterims(overlapping)
    let coverage = 0
    let matched: string[] | null = null
    for (let i = 0; i < utterances.length; i++) {
      const single = coverageOf(micTokens, utterances[i].tokens)
      if (single > coverage) {
        coverage = single
        matched = utterances[i].seq
      }
      const next = utterances[i + 1]
      if (!next) continue
      const pair = coverageOf(micTokens, new Set([...utterances[i].tokens, ...next.tokens]))
      if (pair > coverage) {
        coverage = pair
        matched = [...utterances[i].seq, ...next.seq]
      }
    }

    let isEcho: boolean
    if (micTokens.length >= this.minTokens) {
      // Set matching alone ignores word order, which is what makes accidental
      // matches on common words easy; the utterance must also reproduce one of
      // the mic text's word pairs back to back.
      isEcho = matched !== null && coverage >= this.coverage && sharesBigram(micTokens, matched)
    } else {
      // Short mic texts skip the coverage gate so backchannels ("yeah",
      // "okay") survive — but echo FRAGMENTS leak through that exemption when
      // Deepgram splits a sentence across mic finals. Real-world leaks (Pass
      // A/B, 6/11) shaped two narrower rules, each requiring a single
      // overlapping system entry that contains every mic token:
      //  - embedded: the entry is much longer ("guest." inside "special
      //    guest, my husband Dan. Hello.", "History books." inside the full
      //    sentence). Floor of 5 keeps single tokens out of trivial matches.
      //  - verbatim: 2+ mic tokens that token-for-token equal the whole entry
      //    ("Called Constantinople." vs "Called Constantinople."). The user
      //    saying the identical short phrase in the same two-second window is
      //    far rarer than speaker bleed, so the duplicate is treated as echo.
      // Lone single tokens matching only short entries ("yeah" vs "yeah.")
      // are still always kept.
      const micSet = new Set(micTokens)
      isEcho = overlapping.some((e) => {
        if (!micTokens.every((t) => e.tokens.has(t))) return false
        const embedded = e.tokens.size >= Math.max(5, 3 * micTokens.length)
        const verbatim = micTokens.length >= 2 && e.tokens.size === micSet.size
        return embedded || verbatim
      })
    }

    return {
      isEcho,
      micTokenCount: micTokens.length,
      coverage,
      unionSize: systemUnion.size,
      entryCount: this.entries.length,
      nearestStartDeltaMs
    }
  }

  /** Collapse each system utterance to its richest revision: observeSystem
   *  stores every interim, and all revisions of one utterance share its start
   *  time, so the final (longest) one stands in for the whole group. */
  private mergeInterims(overlapping: SystemEntry[]): SystemEntry[] {
    const byStart = new Map<number, SystemEntry>()
    for (const e of overlapping) {
      const prev = byStart.get(e.startMs)
      if (!prev || e.tokens.size > prev.tokens.size) byStart.set(e.startMs, e)
    }
    return [...byStart.values()].sort((a, b) => a.startMs - b.startMs)
  }

  reset(): void {
    this.entries = []
  }
}
