// Crash-recovery stress: a hard kill mid-recording (SIGKILL, power loss)
// commits transcript finals one at a time but never reaches the stop-time
// reindex — and because chunked_at was already stamped by an earlier reindex,
// the chunk backfill skips the note forever. The startup recovery path
// (recoverTransientStatuses → takeRecoveredMeetingIds → reindexMeetings) is
// what makes those spoken words searchable again; this suite proves it.
//
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/crash-recovery.ts
import { closeDb, getDb, takeRecoveredMeetingIds, withTransaction } from '../../src/main/db/database.ts'
import {
  createMeeting,
  getMeeting,
  saveNotes,
  updateStatus,
  updateTitle
} from '../../src/main/db/meetings.ts'
import { insertSegment } from '../../src/main/db/transcripts.ts'
import { reindexMeeting, reindexMeetings, searchMeetings } from '../../src/main/db/search.ts'
import { header, result } from './_util.ts'

function doc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })
}

// ---------------------------------------------------------------------------
header('Hard kill mid-recording, then startup recovery')
// ---------------------------------------------------------------------------

const m = createMeeting().id
updateTitle(m, 'Crash victim')
saveNotes(m, doc('typed words before the crash'))
reindexMeeting(m) // stamps chunked_at — the backfill will NOT revisit this note

// The recording: finals commit one at a time, then the process dies before
// recorder.stop() ever runs its reindex.
getDb().prepare("UPDATE meetings SET status = 'recording', started_at = ? WHERE id = ?").run(
  Date.now() - 60_000,
  m
)
insertSegment(m, 'mic', 'zanzibar shibboleth spoken mid crash', 1_000, 3_000)
insertSegment(m, 'system', 'quorum answered aloud', 4_000, 6_000, 0)

result(
  'the trap is real: spoken words invisible to search before recovery',
  !searchMeetings('zanzibar shibboleth').some((r) => r.id === m)
)

// "Crash": drop the handle. "Relaunch": the next getDb runs recovery.
closeDb()
const recovered = takeRecoveredMeetingIds()
result('recovery reports the stranded meeting', recovered.includes(m), recovered.join(','))
const after = getMeeting(m)!
result(
  'status recovered with a coalesced end time',
  after.status === 'recorded' && after.endedAt !== null
)

// What registerIpc does at startup with the recovered ids.
reindexMeetings(recovered)
result(
  'recovered transcript is searchable again',
  searchMeetings('zanzibar shibboleth').some((r) => r.id === m) &&
    searchMeetings('quorum answered').some((r) => r.id === m)
)
result(
  'typed notes survived alongside',
  searchMeetings('typed words before').some((r) => r.id === m)
)
result('a clean relaunch recovers nothing', takeRecoveredMeetingIds().length === 0 || (closeDb(), takeRecoveredMeetingIds().length === 0))

// ---------------------------------------------------------------------------
header('withTransaction atomicity')
// ---------------------------------------------------------------------------

const t = createMeeting().id
updateTitle(t, 'Original title')
reindexMeeting(t)
let threw = false
try {
  withTransaction(() => {
    updateTitle(t, 'Half-written title')
    reindexMeeting(t)
    throw new Error('simulated failure between write and commit')
  })
} catch {
  threw = true
}
result('the failing transaction throws', threw)
result(
  'nothing half-written survives: title and FTS both rolled back',
  getMeeting(t)!.title === 'Original title' &&
    searchMeetings('Original title').some((r) => r.id === t) &&
    !searchMeetings('Half-written').some((r) => r.id === t)
)
