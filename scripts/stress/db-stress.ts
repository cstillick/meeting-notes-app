// DB stress: seeds 10k meetings / 100k segments through the real src/main/db code,
// times list/search/reindex/cascade-delete, checks WAL growth and concurrent access.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/db-stress.ts
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { getDb, closeDb } from '../../src/main/db/database.ts'
import {
  createMeeting,
  listMeetings,
  updateTitle,
  saveNotes,
  deleteMeeting,
  getMeeting
} from '../../src/main/db/meetings.ts'
import { insertSegment, getSegments } from '../../src/main/db/transcripts.ts'
import { reindexMeeting, searchMeetings } from '../../src/main/db/search.ts'
import { time, header, result } from './_util.ts'

const dir = process.env.STRESS_USERDATA_DIR!
const dbPath = join(dir, 'granola-clone.db')
console.log(`sandbox: ${dir}`)

const WORDS =
  'sync roadmap budget launch metrics deepgram quarterly review action items follow up demo hiring pipeline infra deploy postmortem retro standup blockers okr revenue churn onboarding design api latency'.split(
    ' '
  )
const sentence = (i: number): string =>
  Array.from({ length: 12 }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ')

const N_MEETINGS = 10_000
const SEGMENTS_PER_BIG = 10_000 // one "marathon" meeting
const SEGMENTS_PER_NORMAL = 10 // on 9k meetings → ~90k + 10k = ~100k total

header('Seed: per-call latency (real app path, no transaction)')
const sampleIds: string[] = []
time('createMeeting x1000 (unbatched, as the app does)', () => {
  for (let i = 0; i < 1000; i++) sampleIds.push(createMeeting().id)
})

header('Seed: bulk (wrapped in transactions for speed)')
const db = getDb()
const ids: string[] = [...sampleIds]
time(`createMeeting x${N_MEETINGS - 1000} (batched)`, () => {
  db.exec('BEGIN')
  for (let i = 1000; i < N_MEETINGS; i++) ids.push(createMeeting().id)
  db.exec('COMMIT')
})
time('updateTitle + saveNotes x10k (batched)', () => {
  db.exec('BEGIN')
  ids.forEach((id, i) => {
    updateTitle(id, `Meeting ${i} ${sentence(i)}`)
    saveNotes(
      id,
      JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: sentence(i + 1) }] },
          { type: 'paragraph', content: [{ type: 'text', text: sentence(i + 2) }] }
        ]
      })
    )
  })
  db.exec('COMMIT')
})

const bigId = ids[0]
time(`insertSegment x${SEGMENTS_PER_BIG} into one meeting (batched)`, () => {
  db.exec('BEGIN')
  for (let i = 0; i < SEGMENTS_PER_BIG; i++) {
    insertSegment(bigId, i % 2 ? 'mic' : 'system', sentence(i), i * 3000, i * 3000 + 2900)
  }
  db.exec('COMMIT')
})
time(`insertSegment x${9000 * SEGMENTS_PER_NORMAL} across 9k meetings (batched)`, () => {
  db.exec('BEGIN')
  for (let m = 1000; m < N_MEETINGS; m++) {
    for (let s = 0; s < SEGMENTS_PER_NORMAL; s++) {
      insertSegment(ids[m], s % 2 ? 'mic' : 'system', sentence(m + s), s * 3000, s * 3000 + 2900)
    }
  }
  db.exec('COMMIT')
})

header('Reindex')
time('reindexMeeting x100 (sampled, unbatched as app does)', () => {
  for (let i = 0; i < 100; i++) reindexMeeting(ids[i * 37])
})
time('reindexMeeting big meeting (10k segments)', () => reindexMeeting(bigId))
time(`reindexMeeting all ${N_MEETINGS} (batched)`, () => {
  db.exec('BEGIN')
  for (const id of ids) reindexMeeting(id)
  db.exec('COMMIT')
})

header('Read paths at 10k meetings / ~100k segments')
const list = time('listMeetings (10k rows)', () => listMeetings())
result('listMeetings count', list.length === N_MEETINGS, `${list.length}`)
for (const q of ['roadmap', 'deepgram budget', 'nonexistentterm', 'meeting 9']) {
  const hits = time(`searchMeetings("${q}")`, () => searchMeetings(q))
  console.log(`         → ${hits.length} hits`)
}
const segs = time('getSegments (10k segments)', () => getSegments(bigId))
result('getSegments count', segs.length === SEGMENTS_PER_BIG, `${segs.length}`)
time('getMeeting x1000', () => {
  for (let i = 0; i < 1000; i++) getMeeting(ids[i])
})

header('WAL / file sizes')
for (const suffix of ['', '-wal', '-shm']) {
  const p = dbPath + suffix
  if (existsSync(p)) console.log(`  ${p.split('/').pop()}: ${(statSync(p).size / 1e6).toFixed(1)} MB`)
}

header('CASCADE delete')
time('deleteMeeting (10k segments, via FK cascade)', () => deleteMeeting(bigId))
const orphans = db
  .prepare('SELECT count(*) AS c FROM transcript_segments WHERE meeting_id = ?')
  .get(bigId) as { c: number }
const ftsLeft = db
  .prepare('SELECT count(*) AS c FROM search_fts WHERE meeting_id = ?')
  .get(bigId) as { c: number }
result('no orphan segments', orphans.c === 0, `${orphans.c}`)
result('no orphan FTS row', ftsLeft.c === 0, `${ftsLeft.c}`)

header('Concurrent second process (busy_timeout probe)')
// Child opens the same DB (with the app's busy_timeout pragma) and writes while
// we hold the write lock for ~1s. With busy_timeout it should wait and succeed;
// without it, it fails instantly with SQLITE_BUSY.
const child = `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(${JSON.stringify(dbPath)})
db.exec('PRAGMA busy_timeout = 3000')
let ok = 0, busy = 0, other = 0
for (let i = 0; i < 5; i++) {
  try {
    db.prepare("INSERT INTO meetings (id, title, created_at) VALUES (?, ?, ?)").run('child-' + i, 'child', Date.now())
    ok++
  } catch (e) {
    if (String(e).includes('locked') || String(e).includes('busy') || String(e).includes('BUSY')) busy++
    else { other++; if (other === 1) console.error('first other error:', e.message) }
  }
}
console.log(JSON.stringify({ ok, busy, other }))
`
db.exec('BEGIN IMMEDIATE')
db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run('holding write lock', ids[1])
const { spawn } = await import('node:child_process')
const proc = spawn(process.execPath, ['--input-type=module', '-e', child])
let childOut = ''
proc.stdout.on('data', (d: Buffer) => (childOut += d.toString()))
proc.stderr.on('data', (d: Buffer) => (childOut += d.toString()))
await new Promise((r) => setTimeout(r, 1000))
db.exec('COMMIT') // release the lock while the child is still waiting
await new Promise<void>((resolve) => proc.on('exit', () => resolve()))
console.log(`  child (lock held ~1s, busy_timeout 3s): ${childOut.trim()}`)
result('child writes succeeded after waiting out the lock', childOut.includes('"ok":5'))

closeDb()
console.log('\ndb-stress complete')
