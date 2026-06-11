# Echo leak — Pass A findings (for Claude Code)

Real-world pass on the **freshly rebuilt** packaged app, **speakers, no headphones**.
TED-Ed "Rise and Fall of the Byzantine Empire" (single narrator) playing over speakers as
the system ("Them") source while Cooper spoke over it ("Me").

## TL;DR

System ("Them") audio is leaking into the mic ("Me") channel as **near-verbatim duplicates**.
**This is not a coverage-threshold problem. Lowering `DEFAULT_COVERAGE` toward 0.65 will not
fix it** — the leaked echoes already have ~100% token coverage. They evade suppression because
the **time-overlap gate** in `EchoSuppressor.isEcho` isn't finding the matching system segment,
so `systemUnion` is empty and the coverage check never runs. Root cause: the two Deepgram
connections are anchored to **different, audio-misaligned wall-clock epochs**, and the system
channel's audio starts materially later than the mic channel's — pushing the system segment
outside the mic echo's ±`toleranceMs` (2000 ms) window.

## Observed transcript (as pasted)

```
Me:   This is Cooper, and this is a test.          ← genuine speech, correctly kept as "Me"
Me:   His                                          ← stray mic interim/fragment
Me:   History books.                               ← LEAK (echo fragment, 2 tokens)
Them: History books will tell you the Roman Empire fell in the fifth century CE.
Me:   Will tell you the Roman Empire fell in the fifth century CE.   ← LEAK (~100% coverage)
Them: But this would have come as a great
Me:   But this would have come as a great          ← LEAK (exact duplicate)
```

The one line that behaved correctly ("This is Cooper, and this is a test.") is Cooper's own
speech — low overlap with the narration, so it scores low and is correctly kept. Everything the
narrator said is showing up on **both** channels.

## Coverage math (why the threshold is a red herring)

For the leak `Me: "Will tell you the Roman Empire fell in the fifth century CE."` against
`Them: "History books will tell you the Roman Empire fell in the fifth century CE."`:

- mic tokens (12): `will tell you the roman empire fell in the fifth century ce`
- every mic token is present in the system text → **coverage ≈ 12/12 = 1.0**
- current bar is `DEFAULT_COVERAGE = 0.75` (`echoSuppressor.ts:26`)

1.0 ≫ 0.75. If `isEcho` had compared these strings, it would have suppressed. So the failure is
upstream of the coverage comparison: the time-window selection at `echoSuppressor.ts:74-82` is
producing an **empty `systemUnion`** for the mic segment, which makes `isEcho` return `false`
at line 82 before coverage is ever computed.

## Root cause: cross-channel timeline skew

The mic and system channels are two independent `DeepgramSession` instances, each anchoring its
timeline to **its own connection-open wall clock**:

- `deepgramSession.ts:66-69` and `:117` — `connEpoch = Date.now()` is set when the **WebSocket
  opens**.
- `deepgramSession.ts:87,99` — every result's `startMs = connEpoch + message.start * 1000`,
  where `message.start` is relative to **the audio stream** (cumulative audio sent on that
  socket), i.e. it starts counting from the **first audio chunk**, not from WS-open.

The bug is the gap between *WS-open* and *first-audio* differing per channel:

- **Mic**: `getUserMedia` is already live; the renderer starts pushing PCM almost immediately
  after the socket opens.
- **System**: in `recorder.ts:110` both sockets open via `Promise.all([mic.start(),
  system.start()])`, but the `audiotee` helper that produces system PCM is only spawned
  **afterward** (`recorder.ts:112-120`, `this.audiotee.start()`). Spawning the Core Audio
  process-tap helper and getting the first tap delivered takes a noticeable amount of time
  (process launch + tap setup), often **one to several seconds**.

Net effect: for the *same acoustic event*, the system channel's computed `startMs` is shifted
**earlier** relative to the mic channel's by roughly `(system first-audio delay) − (mic
first-audio delay)`. When that skew exceeds `toleranceMs = 2000` (`echoSuppressor.ts:24`), the
mic echo's match window `[micStart − 2000, micEnd + 2000]` (`echoSuppressor.ts:74-75`) no longer
overlaps the corresponding system entry, the `for` loop at `:77-81` adds nothing, `systemUnion`
is empty, and `isEcho` bails at `:82`. The echo commits as "Me". This also explains why **early**
sentences leak worst: the skew is largest right after `audiotee` starts.

### Secondary contributor: the hold window

Mic finals are held `MIC_FINAL_HOLD_MS = 2500` ms (`recorder.ts:63`) so a late system final can
still retract them (`recorder.ts:180-242`). If the system final for the same speech arrives
**> 2500 ms** after the mic final — plausible given the same `audiotee` startup lag plus
Deepgram's own latency — the held mic final flushes and commits (`flushMicFinal`,
`recorder.ts:219-230`) before suppression can fire. Skew and hold-expiry compound.

### Tertiary: sub-`minTokens` fragments are never checked

`History books.` (2 tokens) leaks for a different reason: `isEcho` exempts anything shorter than
`minTokens = 3` (`echoSuppressor.ts:25,72`) so short words like "yeah"/"okay" are never
suppressed. Short echo fragments fall through this exemption by design. Minor relative to the
full-sentence leaks, but worth noting.

## What this means for the named constants

The plan says: if echoes leak, drop `DEFAULT_COVERAGE` toward 0.65. **For this failure mode that
won't help** — coverage is already ~1.0 on the leaked lines; the coverage gate isn't what's
rejecting them. The relevant constant here is `DEFAULT_TOLERANCE_MS` (2000), and even widening it
is only a band-aid. The real fix is removing the cross-channel anchor skew.

## Suggested fixes for Claude Code (in priority order)

1. **Share a single audio-aligned epoch across channels.** Anchor each channel's timeline to the
   moment its **first audio chunk is sent** (not WS-open), or compute one shared `t0` for the
   recording and add each channel's measured first-audio offset. This removes the systematic
   skew at the source and makes the ±tolerance window do its job. Touch points:
   `deepgramSession.ts` (`connEpoch` assignment) and `recorder.ts` (`startedAt` normalization at
   `:146-147`).
2. **Start `audiotee` before / concurrently with opening the system socket**, or hold the system
   `connEpoch` until first PCM, so the system timeline doesn't start "behind."
3. **Widen `DEFAULT_TOLERANCE_MS`** (e.g. 2000 → 4000-5000) and/or raise `MIC_FINAL_HOLD_MS` as a
   stopgap while #1 is implemented. Band-aid, not a fix.
4. **Lower `minTokens` handling for echoes only** if short-fragment leaks matter — e.g. still
   allow suppression of a short mic final when it's a strict subset of a recent system entry.

## How to quantify the skew (confirms the diagnosis)

The persisted segments carry `start_ms` / `end_ms` for both channels, so the actual skew is
recoverable from the DB at `app.getPath('userData')/granola-clone.db`
(`~/Library/Application Support/Granola Clone/granola-clone.db`). For the leaking meeting, pair
each leaked mic row with its overlapping system row and inspect the start delta:

```sql
-- Eyeball mic vs system rows interleaved by time for the meeting under test:
SELECT channel, start_ms, end_ms, text
FROM transcript_segments
WHERE meeting_id = '<MEETING_ID>'
ORDER BY start_ms;
```

For any leaked `mic` row whose text matches a `system` row, compute `mic.start_ms −
system.start_ms`. **If `abs(delta) > 2000`, the skew hypothesis is confirmed** — the echo fell
outside the tolerance window.

Recommended instrumentation: in `recorder.ts onResult`, when a mic final is about to
`commitFinal`, log `micStart/micEnd`, the candidate `systemUnion.size`, the nearest system
entry's `start/end` and its delta, and the computed coverage. That turns this from inference into
a logged measurement on the next pass.

---
*Generated from a live Pass A on speakers. Pass B (two-person diarization) was paused to capture
this; it can resume on request.*

---

## Resolution (Claude Code, 6/11 — after Pass A)

**Actual root cause: the Pass A app was a stale build.** The `dist/mac-arm64/Granola
Clone.app` asar dated June 10 10:18 and contained **no suppression code at all** (zero hits for
`EchoSuppressor`/`isEcho`/`pendingMicFinals`) — the rebuild never landed in the bundle that was
tested. Replaying the exact persisted timestamps of meeting `7d99d6f3` through the current code
(`scripts/stress/echo-leak-repro.ts`) suppresses both full-sentence leaks: the measured skew was
~1.6–2.8 s, and the windows do overlap within tolerance once the entries exist. The
"systemUnion empty" inference was reasoning against code that wasn't running. (Commit order in
the DB — system finals persisted *before* the matching mic finals, with synchronous inserts —
was the giveaway.)

Fixes landed anyway (the skew is real and was uncomfortably close to tolerance):

1. **First-audio epoch anchoring** — `DeepgramSession` now anchors `connEpoch` to the first
   audio chunk actually sent on each connection (WS-open is only a fallback), removing the
   systematic cross-channel skew. Re-arms on every reconnect.
2. **audiotee starts before the sockets are awaited** (`recorder.ts`), shrinking the system
   channel's lost lead-in; cleanup added to the start-failure path.
3. **`MIC_FINAL_HOLD_MS` 2500 → 3500** as cheap insurance against late system finals during
   continuous speech (interims still stream instantly).
4. **Short-fragment rule** — 2-token mic finals like "History books." (which the replay
   confirmed DO leak via the `minTokens` exemption) are now suppressed when embedded in a single
   system entry ≥3× their length; "yeah exactly" vs a short "yeah, exactly." is still kept, and
   single tokens are never suppressed.
5. **`ECHO_DEBUG=1`** logs every mic-final echo decision (coverage, union size, entry count,
   nearest system-entry start delta) via `EchoSuppressor.evaluate()`.

Verification: `npm run typecheck` clean; `echo-leak-repro.ts` (Pass A replay) and
`echo-suppression.ts` all PASS. Package rebuilt 15:17 and verified to contain the new code.
**Before any future real-world pass: check the asar is fresh** —
`ls -la "dist/mac-arm64/Granola Clone.app/Contents/Resources/app.asar"`.

## Round 2 (6/11, fresh build — Passes A and B rerun)

**Anchor fix confirmed working:** the Pass A echo pair ("Called Constantinople.") showed a
cross-channel start delta of **7 ms** (was 1.6–2.8 s). Full-sentence leaks are gone; user
speech ("This is an audio test.", "Very interesting.") correctly kept.

Residual issues observed and addressed:

1. **`Me: Called Constantinople.`** — Deepgram split the phrase into its own short system
   entry, so the mic echo matched it *verbatim* rather than embedded in a longer entry.
   New rule: a 2+-token mic final token-for-token equal to an overlapping system entry is
   suppressed. (This deliberately flips the old "yeah exactly kept" stance: an identical short
   phrase inside the same two-second window is overwhelmingly bleed, not coincidence.)
2. **`Me: guest.` / `Me: conversation` (Pass B)** — single-token fragments embedded in long
   system sentences. Single tokens are now suppressed when contained in one overlapping entry
   of ≥5 tokens; a lone "yeah" against a short "yeah." entry is still always kept.
3. **`Me: Ubashi.`** — garbage mishear of "Which he"; no token overlap, so text matching can't
   catch it. Word confidence is now plumbed through `SessionResult` and logged by `ECHO_DEBUG=1`
   (`conf=`); once a pass shows typical confidence for this class, a threshold filter can follow.
4. **Diarization (Pass B)** — Vanessa got speaker 0 for her first utterance and speaker 1
   thereafter (streaming warm-up drift; not fixable client-side), and the trailing one-word
   `"it."` of "Let's do it." flipped to speaker 0. `groupWordsBySpeaker` now absorbs
   single-word speaker flicker into the neighboring group; genuine one-word finals are
   untouched. Index drift across utterances remains a Deepgram streaming limitation.

All cases pinned in `scripts/stress/echo-leak-repro.ts` (Round 2 section) and
`echo-suppression.ts`; 18/18 PASS. Package rebuilt and asar verified after the changes.
