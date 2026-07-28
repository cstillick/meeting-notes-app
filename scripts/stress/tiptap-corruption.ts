// Corrupted notes_json through reindexMeeting/searchMeetings (pmToText hardening).
// Includes deep-nesting probes for the recursive walk in search.ts.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/tiptap-corruption.ts
import { createMeeting, saveNotes, updateTitle } from '../../src/main/db/meetings.ts'
import { reindexMeeting, searchMeetings } from '../../src/main/db/search.ts'
import { header, result } from './_util.ts'

function deepDoc(depth: number): string {
  // {"type":"doc","content":[ {"content":[ ... {"text":"needle"} ... ]} ]}
  return (
    '{"type":"doc","content":['.repeat(1) +
    '{"content":['.repeat(depth) +
    '{"text":"needle"}' +
    ']}'.repeat(depth) +
    ']}'
  )
}

const CASES: { name: string; blob: string; searchable?: string }[] = [
  { name: 'truncated json', blob: '{"type":"doc","content":[{"ty' },
  { name: 'root array', blob: '[1,2,3]' },
  { name: 'root string', blob: '"just a string"' },
  { name: 'root number', blob: '42' },
  { name: 'null', blob: 'null' },
  { name: 'empty string', blob: '' },
  { name: 'doc no content', blob: '{"type":"doc"}' },
  { name: 'text not string', blob: '{"type":"doc","content":[{"text":12345}]}' },
  { name: 'content not array', blob: '{"type":"doc","content":"oops"}' },
  { name: 'nested 1k', blob: deepDoc(1_000), searchable: 'needle' },
  { name: 'nested 10k', blob: deepDoc(10_000), searchable: 'needle' },
  { name: 'nested 100k', blob: deepDoc(100_000), searchable: 'needle' },
  {
    name: '10MB text node',
    blob: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bigblob ' + 'a'.repeat(10_000_000) }] }]
    }),
    searchable: 'bigblob'
  }
]

header('Corrupted / extreme notes_json → reindexMeeting')
for (const c of CASES) {
  const m = createMeeting()
  updateTitle(m.id, `corrupt ${c.name}`)
  saveNotes(m.id, c.blob)
  let outcome = 'ok'
  const t0 = Date.now()
  try {
    reindexMeeting(m.id)
  } catch (e) {
    outcome = `reindex THREW: ${(e as Error).message}`
  }
  const ms = Date.now() - t0
  if (c.searchable && outcome === 'ok') {
    try {
      const hits = searchMeetings(c.searchable)
      if (!hits.some((h) => h.id === m.id)) outcome = `"${c.searchable}" NOT in index`
    } catch (e) {
      outcome = `search THREW: ${(e as Error).message}`
    }
  }
  const found = c.searchable ? ', indexed text found' : ''
  result(c.name, outcome === 'ok', `${ms}ms${outcome === 'ok' ? found : `, ${outcome}`}`)
}

header('Sanity: search still works afterwards')
const m = createMeeting()
updateTitle(m.id, 'sanity zebra meeting')
reindexMeeting(m.id)
result('post-corruption search works', searchMeetings('zebra').some((h) => h.id === m.id))
console.log('\ntiptap-corruption complete')
