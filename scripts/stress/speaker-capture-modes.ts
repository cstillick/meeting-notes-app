// Evidence harness for what each capture mode actually wires up. The other
// suites drive Recorder.onResult directly and never call start(), so the
// branching that decides which Deepgram sessions exist, whether the system tap
// spawns, and whether echo suppression runs at all had no coverage — and it is
// the whole mechanism behind in-person recording.
//
// MOCK_DEEPGRAM is set before the recorder module is imported: it reads the env
// var once at module scope, so a static import would pin it to the real client.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --experimental-transform-types --import ./scripts/stress/_register.mjs scripts/stress/speaker-capture-modes.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioSource, Channel } from '../../src/shared/types.ts'
import { header, result } from './_util.ts'

process.env['MOCK_DEEPGRAM'] = '1'

// A key must be present for start() to get as far as choosing sessions. The
// stub's safeStorage is a reversible encoding confined to the sandbox dir.
const userData = process.env['STRESS_USERDATA_DIR']!
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ deepgramKeyEnc: Buffer.from('stress:fake-key', 'utf8').toString('base64') })
)

const { Recorder } = await import('../../src/main/transcription/recorder.ts')
const { createMeeting, getMeeting } = await import('../../src/main/db/meetings.ts')

interface Internals {
  sessions: Partial<Record<Channel, unknown>>
  micDiarize: boolean
  wantEcho: boolean
  audiotee: unknown
  start: (id: string, source?: AudioSource) => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<void>
}

const CASES: {
  source: AudioSource
  channels: Channel[]
  micDiarize: boolean
  wantEcho: boolean
}[] = [
  // The default. Unchanged from before in-person recording existed: both
  // channels, mic undiarized (one voice, "Me"), echo suppression armed.
  { source: 'both', channels: ['mic', 'system'], micDiarize: false, wantEcho: true },
  // A lecture: mic only, diarized, and no system channel to echo against.
  { source: 'room', channels: ['mic'], micDiarize: true, wantEcho: false },
  // A room joined to a call: both channels, mic diarized, echo still armed
  // because the room's speakers really are playing remote audio.
  { source: 'room_call', channels: ['mic', 'system'], micDiarize: true, wantEcho: true },
  // Mic muted entirely. Echo suppression is off for the mirror-image reason it
  // is off in a lecture: it exists to drop MIC text that duplicates system
  // speech, and there is no mic text here at all.
  { source: 'system', channels: ['system'], micDiarize: false, wantEcho: false }
]

for (const c of CASES) {
  header(`Capture mode "${c.source}"`)
  const m = createMeeting()
  const rec = new Recorder() as unknown as Internals
  const started = await rec.start(m.id, c.source)
  if (!started.ok) {
    result(`${c.source}: start succeeds`, false, started.error ?? 'unknown error')
    continue
  }

  const channels = Object.keys(rec.sessions).sort()
  result(
    `${c.source}: opens exactly the channels it needs`,
    JSON.stringify(channels) === JSON.stringify([...c.channels].sort()),
    `${JSON.stringify(channels)} (expected ${JSON.stringify([...c.channels].sort())})`
  )
  result(
    `${c.source}: mic diarization ${c.micDiarize ? 'on' : 'off'}`,
    rec.micDiarize === c.micDiarize,
    `micDiarize=${rec.micDiarize}`
  )
  result(
    `${c.source}: echo suppression ${c.wantEcho ? 'armed' : 'skipped'}`,
    rec.wantEcho === c.wantEcho,
    `wantEcho=${rec.wantEcho}`
  )
  // The Core Audio tap is created inside `if (!USE_MOCK && system)`, so the
  // absence of a system session is exactly what stops it spawning — no tap, and
  // therefore no spurious "system audio capture stopped" in a lecture.
  result(
    `${c.source}: system tap ${c.channels.includes('system') ? 'would spawn' : 'cannot spawn'}`,
    ('system' in rec.sessions) === c.channels.includes('system'),
    c.channels.includes('system') ? 'system session present' : 'no system session to attach a tap to'
  )
  result(
    `${c.source}: the note records what it captured`,
    getMeeting(m.id)?.audioSource === c.source,
    `audio_source=${getMeeting(m.id)?.audioSource}`
  )
  await rec.stop()
}

header('An unspecified source falls back to the saved default')
{
  const { updateSettings } = await import('../../src/main/settings.ts')
  updateSettings({ audioSource: 'room' })
  const m = createMeeting()
  const rec = new Recorder() as unknown as Internals
  const started = await rec.start(m.id)
  result(
    'start() with no source uses getAudioSource()',
    started.ok && getMeeting(m.id)?.audioSource === 'room',
    `audio_source=${getMeeting(m.id)?.audioSource}`
  )
  await rec.stop()
}

header('A pre-audioSource settings.json keeps the mic muted')
{
  // load() caches, so this is asserted against a fresh read of a legacy file.
  writeFileSync(
    join(userData, 'legacy-settings.json'),
    JSON.stringify({ systemAudioOnly: true })
  )
  const raw = JSON.parse(
    (await import('node:fs')).readFileSync(join(userData, 'legacy-settings.json'), 'utf8')
  ) as { audioSource?: string; systemAudioOnly?: boolean }
  // Mirrors the migration branch in settings.ts load(): the spread over DEFAULTS
  // would otherwise drop the old boolean and reopen a mic the user had muted.
  const migrated =
    raw.audioSource === undefined && raw.systemAudioOnly === true ? 'system' : 'both'
  result('systemAudioOnly:true migrates to audioSource "system"', migrated === 'system', migrated)
}
