// Knowledge-graph stress: the entities schema (v10), the app-side graph
// queries, and the MCP graph tools — everything except the Claude extraction
// call itself, which is exercised with synthetic extractions here and by the
// real-app verification pass.
//
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/knowledge-graph.ts
import { join } from 'node:path'

import { getDb } from '../../src/main/db/database.ts'
import { createMeeting, updateTitle } from '../../src/main/db/meetings.ts'
import { createFolder, setMeetingFolder } from '../../src/main/db/folders.ts'
import { reindexMeeting } from '../../src/main/db/search.ts'
import {
  clearEntitiesStamp,
  entityCoverage,
  graphData,
  listEntitiesForNote,
  listUnextractedMeetingIds,
  normalizeEntityName,
  relatedNotes,
  saveNoteEntities
} from '../../src/main/db/entities.ts'
import { openLibrary, type Library } from '../../src/mcp/db.ts'
import { getGraphTool, getNoteTool, relatedNotesTool } from '../../src/mcp/tools.ts'
import { header, result } from './_util.ts'

const dir = process.env.STRESS_USERDATA_DIR!
const dbPath = join(dir, 'granola-clone.db')

function count(sql: string, ...params: (string | number)[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n
}

// ---------------------------------------------------------------------------
header('Schema and extraction bookkeeping')
// ---------------------------------------------------------------------------

const folder = createFolder('Econ')
const a = createMeeting().id
updateTitle(a, 'Fiscal policy lecture')
setMeetingFolder(a, folder.id)
reindexMeeting(a)
const b = createMeeting().id
updateTitle(b, 'Multipliers seminar')
setMeetingFolder(b, folder.id)
reindexMeeting(b)
const c = createMeeting().id
updateTitle(c, 'Unrelated standup')
reindexMeeting(c)

result(
  'fresh notes queue for extraction',
  listUnextractedMeetingIds(10).length >= 3
)

saveNoteEntities(a, [
  { name: 'Fiscal Multiplier', kind: 'concept', weight: 0.9 },
  { name: 'Fiscal Policy', kind: 'topic', weight: 0.8 },
  { name: 'John Maynard Keynes', kind: 'person', weight: 0.5 }
])
saveNoteEntities(b, [
  // Case/spacing variant must merge into the same entity.
  { name: 'fiscal  multiplier', kind: 'concept', weight: 0.7 },
  { name: 'Ricardian Equivalence', kind: 'concept', weight: 0.6 }
])
saveNoteEntities(c, [{ name: 'Sprint Planning', kind: 'concept', weight: 0.9 }])

result('normalize collapses case and whitespace', normalizeEntityName(' Fiscal  Multiplier ') === 'fiscal multiplier')
result(
  'entity dedup by normalized name',
  count("SELECT COUNT(*) AS n FROM entities WHERE norm = 'fiscal multiplier'") === 1
)
result(
  'first-seen display name wins',
  (getDb().prepare("SELECT name FROM entities WHERE norm = 'fiscal multiplier'").get() as { name: string }).name ===
    'Fiscal Multiplier'
)
result('extraction stamps entities_at', listUnextractedMeetingIds(10).length === 0)
const coverage = entityCoverage()
result('coverage reflects extraction', coverage.extracted === coverage.total && coverage.total >= 3)

clearEntitiesStamp(b)
result('clearing a stamp re-queues exactly that note', listUnextractedMeetingIds(10).join(',') === b)
saveNoteEntities(b, [
  { name: 'Fiscal Multiplier', kind: 'concept', weight: 0.7 },
  { name: 'Sticky Prices', kind: 'concept', weight: 0.6 }
])
result(
  're-extraction prunes entities no note carries',
  count("SELECT COUNT(*) AS n FROM entities WHERE norm = 'ricardian equivalence'") === 0
)

// ---------------------------------------------------------------------------
header('Graph queries')
// ---------------------------------------------------------------------------

const all = graphData(null)
const noteNodes = all.nodes.filter((n) => n.kind === 'note')
const entityNodes = all.nodes.filter((n) => n.kind !== 'note')
result('bipartite graph has both node kinds', noteNodes.length === 3 && entityNodes.length >= 4)
result(
  'links join notes to entities',
  all.links.length >= 5 && all.links.every((l) => l.source.startsWith('n:') && l.target.startsWith('e:'))
)

const scoped = graphData(folder.id)
result(
  'folder scope drops the unrelated note and its concepts',
  scoped.nodes.every((n) => n.label !== 'Unrelated standup' && n.label !== 'Sprint Planning')
)

const rel = relatedNotes(a, 5)
result(
  'related notes ranked by shared salience with reasons',
  rel.length === 1 && rel[0].id === b && rel[0].shared.includes('Fiscal Multiplier'),
  JSON.stringify(rel)
)

// ---------------------------------------------------------------------------
header('MCP graph tools')
// ---------------------------------------------------------------------------

const lib: Library = openLibrary(dbPath)
const graphText = getGraphTool(lib, { limit: 40 })
result(
  'get_graph lists concepts with their notes',
  graphText.includes('Fiscal Multiplier (concept, 2 notes)') &&
    graphText.includes('Fiscal policy lecture') &&
    graphText.includes('Multipliers seminar'),
  graphText.slice(0, 200)
)
const graphScoped = getGraphTool(lib, { folder: 'Econ', limit: 40 })
result('get_graph folder scope holds', !graphScoped.includes('Sprint Planning'))

const relText = relatedNotesTool(lib, { note_id: a, limit: 10 })
result(
  'related_notes names the tie',
  relText.includes('Multipliers seminar') && relText.includes('Fiscal Multiplier'),
  relText.slice(0, 200)
)

const noteText = getNoteTool(lib, {
  note_id: a,
  include: ['rough_notes', 'enhanced_notes'],
  max_chars: 4000
})
result(
  'get_note carries the concepts line',
  noteText.includes('concepts: Fiscal Multiplier, Fiscal Policy, John Maynard Keynes'),
  noteText.split('\n').slice(0, 4).join(' | ')
)
