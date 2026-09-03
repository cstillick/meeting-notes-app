// Per-note speaker identity: who each diarized voice actually is.
//
// Deepgram returns anonymous integers and renumbers them from 0 on every
// websocket connection, so a name can only ever be local to this app — there is
// no enrollment API, no voiceprint and no exposed embedding to attach one to.
// And one person legitimately holds SEVERAL raw keys: a mid-meeting reconnect
// or a second recording on the same note both start a fresh numbering.
//
// Hence the indirection. A *key* is one (channel, speaker) pair the transcript
// actually contains; an *identity* is a person. Many keys map onto one
// identity, so merging a voice the diarizer split is a repoint of one row —
// never a rewrite of the transcript. Names are never stamped onto segment rows,
// which is what makes a rename relabel every line already stored and every line
// still to arrive, at the cost of a single write.
import type { Channel, SpeakerIdentity } from '@shared/types'
import { getDb } from './database'
import { defaultSpeakerLabel, speakerKey } from '../enhance/prompt'

/** Distinct bubble colors a note can hand out before wrapping. Mirrored by
 *  SPEAKER_PALETTE in the renderer's TranscriptPanel. */
export const SPEAKER_PALETTE_SIZE = 8

/** Longest assigned name. Bounds the per-line prompt overhead fitTranscript
 *  charges, so one absurd name cannot evict half a transcript from the window. */
const MAX_NAME_CHARS = 60

/** The undiarized sentinel — the same one idx_segments_unique coalesces a NULL
 *  speaker to, so "Me" and "Them" are nameable on pre-diarization notes. */
const UNDIARIZED = -1

interface RosterRow {
  channel: Channel
  speaker: number
  line_count: number
  talk_ms: number | null
  first_ms: number
  identity_id: number | null
  name: string | null
  color_index: number | null
  is_me: number | null
  source: 'user' | 'suggested' | null
}

const ROSTER_SQL = `
  SELECT s.channel                  AS channel,
         COALESCE(s.speaker, ${UNDIARIZED}) AS speaker,
         COUNT(*)                   AS line_count,
         SUM(MAX(0, s.end_ms - s.start_ms)) AS talk_ms,
         MIN(s.start_ms)            AS first_ms,
         i.id                       AS identity_id,
         i.name                     AS name,
         i.color_index              AS color_index,
         i.is_me                    AS is_me,
         i.source                   AS source
    FROM transcript_segments s
    LEFT JOIN speaker_keys k ON k.meeting_id = s.meeting_id
                            AND k.channel    = s.channel
                            AND k.speaker    = COALESCE(s.speaker, ${UNDIARIZED})
    LEFT JOIN speaker_identities i ON i.id = k.identity_id
   WHERE s.meeting_id = ?
   GROUP BY s.channel, COALESCE(s.speaker, ${UNDIARIZED})
   ORDER BY first_ms, s.channel, speaker
`

/** Every distinct voice in a note's transcript, in order of first appearance,
 *  joined to whatever identity the user assigned it. A voice with no identity
 *  still appears, carrying its generated label — the roster is derived from the
 *  transcript, so a speaker shows up the moment they first say something. */
export function speakerRoster(meetingId: string): SpeakerIdentity[] {
  const rows = getDb().prepare(ROSTER_SQL).all(meetingId) as unknown as RosterRow[]
  return rows.map((r, ordinal) => {
    const speaker = r.speaker === UNDIARIZED ? null : r.speaker
    return {
      identityId: r.identity_id,
      channel: r.channel,
      speaker,
      label: r.name ?? defaultSpeakerLabel(r.channel, speaker),
      name: r.name,
      // An unnamed voice has no stored color yet; give it a stable one from its
      // position so the panel does not recolor every chip when one is named.
      colorIndex:
        r.identity_id !== null && r.color_index !== null
          ? r.color_index
          : ordinal % SPEAKER_PALETTE_SIZE,
      isMe: r.is_me === 1,
      source: r.source,
      lineCount: r.line_count,
      talkMs: r.talk_ms ?? 0,
      firstMs: r.first_ms
    }
  })
}

/** ONLY the user-assigned names, keyed by speakerKey(). Empty for a note with
 *  no identities — which is what makes passing it to speakerLabel provably a
 *  no-op there, and why every un-named note's prompts, exports and MCP output
 *  are byte-identical to what they were before names existed. */
export function speakerNameMap(meetingId: string): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT k.channel AS channel, k.speaker AS speaker, i.name AS name
         FROM speaker_keys k
         JOIN speaker_identities i ON i.id = k.identity_id
        WHERE k.meeting_id = ? AND i.name IS NOT NULL AND i.name <> ''`
    )
    .all(meetingId) as unknown as { channel: Channel; speaker: number; name: string }[]
  const map = new Map<string, string>()
  for (const r of rows) {
    map.set(speakerKey(r.channel, r.speaker === UNDIARIZED ? null : r.speaker), r.name)
  }
  return map
}

/** The lowest palette slot this note is not already using. A COUNT would
 *  collide the moment an identity is deleted (clearSpeaker, mergeSpeakers both
 *  do), handing a new speaker a colour another one is still showing. Falls back
 *  to wrapping on the count once every slot is taken. */
function freeColorIndex(meetingId: string): number {
  const rows = getDb()
    .prepare('SELECT color_index AS c FROM speaker_identities WHERE meeting_id = ?')
    .all(meetingId) as unknown as { c: number }[]
  const taken = new Set(rows.map((r) => r.c))
  for (let i = 0; i < SPEAKER_PALETTE_SIZE; i++) {
    if (!taken.has(i)) return i
  }
  return rows.length % SPEAKER_PALETTE_SIZE
}

/** The identity a key points at, creating one if the key is unclaimed. */
function identityFor(meetingId: string, channel: Channel, speaker: number): number {
  const db = getDb()
  const existing = db
    .prepare(
      'SELECT identity_id AS id FROM speaker_keys WHERE meeting_id = ? AND channel = ? AND speaker = ?'
    )
    .get(meetingId, channel, speaker) as { id: number } | undefined
  if (existing) return existing.id

  const info = db
    .prepare(
      'INSERT INTO speaker_identities (meeting_id, color_index, created_at) VALUES (?, ?, ?)'
    )
    .run(meetingId, freeColorIndex(meetingId), Date.now())
  const identityId = Number(info.lastInsertRowid)
  db.prepare(
    'INSERT INTO speaker_keys (meeting_id, channel, speaker, identity_id) VALUES (?, ?, ?, ?)'
  ).run(meetingId, channel, speaker, identityId)
  return identityId
}

/** Name a voice. An empty name resets it to the generated label instead of
 *  storing a blank one. Returns the whole refreshed roster: every caller is
 *  about to re-render it anyway, and returning it makes the write atomic from
 *  the renderer's point of view. */
export function setSpeakerName(
  meetingId: string,
  channel: Channel,
  speaker: number,
  name: string
): SpeakerIdentity[] {
  const clean = name.trim().slice(0, MAX_NAME_CHARS)
  if (!clean) return clearSpeaker(meetingId, channel, speaker)
  const identityId = identityFor(meetingId, channel, speaker)
  getDb()
    .prepare("UPDATE speaker_identities SET name = ?, source = 'user' WHERE id = ?")
    .run(clean, identityId)
  return speakerRoster(meetingId)
}

/** Accept a machine-proposed name, marked so the UI can show it as a suggestion
 *  the user has not vetted. Same write path as setSpeakerName otherwise. */
export function setSuggestedName(
  meetingId: string,
  channel: Channel,
  speaker: number,
  name: string
): SpeakerIdentity[] {
  const clean = name.trim().slice(0, MAX_NAME_CHARS)
  if (!clean) return speakerRoster(meetingId)
  const identityId = identityFor(meetingId, channel, speaker)
  getDb()
    .prepare("UPDATE speaker_identities SET name = ?, source = 'suggested' WHERE id = ?")
    .run(clean, identityId)
  return speakerRoster(meetingId)
}

/** Forget everything about a voice: it falls back to its generated label. The
 *  identity row goes too, but only once no other key still points at it — a
 *  merged identity must survive its other keys. */
export function clearSpeaker(
  meetingId: string,
  channel: Channel,
  speaker: number
): SpeakerIdentity[] {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT identity_id AS id FROM speaker_keys WHERE meeting_id = ? AND channel = ? AND speaker = ?'
    )
    .get(meetingId, channel, speaker) as { id: number } | undefined
  if (!row) return speakerRoster(meetingId)
  db.prepare(
    'DELETE FROM speaker_keys WHERE meeting_id = ? AND channel = ? AND speaker = ?'
  ).run(meetingId, channel, speaker)
  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM speaker_keys WHERE identity_id = ?')
    .get(row.id) as { n: number }
  if (remaining.n === 0) {
    db.prepare('DELETE FROM speaker_identities WHERE id = ?').run(row.id)
  }
  return speakerRoster(meetingId)
}

/** Mark a voice as the note-taker. Clears any previous one first: the partial
 *  unique index makes two simultaneous "me" rows unrepresentable, so setting
 *  the new one without clearing the old would throw rather than replace. */
export function setSpeakerIsMe(
  meetingId: string,
  channel: Channel,
  speaker: number
): SpeakerIdentity[] {
  const db = getDb()
  db.prepare('UPDATE speaker_identities SET is_me = 0 WHERE meeting_id = ? AND is_me = 1').run(
    meetingId
  )
  const identityId = identityFor(meetingId, channel, speaker)
  db.prepare('UPDATE speaker_identities SET is_me = 1 WHERE id = ?').run(identityId)
  return speakerRoster(meetingId)
}

/** "These two voices are the same person" — the fix for a diarizer split, and
 *  for the fresh index a reconnect or a re-recording hands the same human.
 *  Repoints keys; touches no transcript row. */
export function mergeSpeakers(
  meetingId: string,
  fromIdentityId: number,
  intoIdentityId: number
): SpeakerIdentity[] {
  if (fromIdentityId === intoIdentityId) return speakerRoster(meetingId)
  const db = getDb()
  const owned = db
    .prepare(
      'SELECT COUNT(*) AS n FROM speaker_identities WHERE meeting_id = ? AND id IN (?, ?)'
    )
    .get(meetingId, fromIdentityId, intoIdentityId) as { n: number }
  // Both must belong to this note: a merge across notes would silently move one
  // person's name onto another meeting's voice.
  if (owned.n !== 2) return speakerRoster(meetingId)

  // Fold the absorbed identity's attributes across before deleting it.
  // Otherwise merging the note-taker INTO someone else silently leaves the note
  // with no is_me row at all — no error, since the partial unique index is only
  // happier — and the user's own bubbles stop being right-aligned with no way to
  // see why. Same for the name: merging a named voice into an unnamed one would
  // discard the name the merge was performed to apply.
  const from = db
    .prepare('SELECT name, is_me AS isMe, source FROM speaker_identities WHERE id = ?')
    .get(fromIdentityId) as { name: string | null; isMe: number; source: string } | undefined
  const into = db
    .prepare('SELECT name FROM speaker_identities WHERE id = ?')
    .get(intoIdentityId) as { name: string | null } | undefined

  db.prepare('UPDATE speaker_keys SET identity_id = ? WHERE meeting_id = ? AND identity_id = ?').run(
    intoIdentityId,
    meetingId,
    fromIdentityId
  )
  // Delete first: is_me is guarded by a partial unique index, so both rows must
  // never carry it at once.
  db.prepare('DELETE FROM speaker_identities WHERE id = ?').run(fromIdentityId)
  if (from?.isMe === 1) {
    db.prepare('UPDATE speaker_identities SET is_me = 1 WHERE id = ?').run(intoIdentityId)
  }
  if (from?.name && !into?.name) {
    db.prepare('UPDATE speaker_identities SET name = ?, source = ? WHERE id = ?').run(
      from.name,
      from.source,
      intoIdentityId
    )
  }
  return speakerRoster(meetingId)
}

/** Distinct assigned names on a note, for the FTS body. Chunk text deliberately
 *  never carries them (a rename would re-embed the whole note), so this is the
 *  only place a name becomes searchable. */
export function assignedNames(meetingId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT i.name AS name
         FROM speaker_identities i
        WHERE i.meeting_id = ? AND i.name IS NOT NULL AND i.name <> ''`
    )
    .all(meetingId) as unknown as { name: string }[]
  return rows.map((r) => r.name)
}
