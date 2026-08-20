// Export stress: the pure/deterministic halves of every exporter — note
// markdown, the Obsidian vault (wikilinks + concept stubs), the JSON bundle,
// the hand-rolled DOCX container, HTML hardening, and the Notion block
// conversion. PDF (Chromium print) and the live Notion API belong to the
// real-app verification pass.
//
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/exports.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMeeting, getMeeting, saveEnhanced, saveNotes, updateTitle } from '../../src/main/db/meetings.ts'
import { createFolder, setMeetingFolder } from '../../src/main/db/folders.ts'
import { insertSegment, getSegments } from '../../src/main/db/transcripts.ts'
import { reindexMeeting } from '../../src/main/db/search.ts'
import { saveNoteEntities } from '../../src/main/db/entities.ts'
import { buildVault, noteToMarkdown, safeName, stripSentinels } from '../../src/main/export/markdown.ts'
import { buildJsonBundle } from '../../src/main/export/jsonBundle.ts'
import { buildZip, markdownToDocx } from '../../src/main/export/docx.ts'
import { markdownToHtmlDocument } from '../../src/main/export/html.ts'
import { markdownToNotionBlocks, normalizePageId } from '../../src/main/export/notion.ts'
import { header, result } from './_util.ts'

function doc(...paragraphs: string[]): string {
  return JSON.stringify({
    type: 'doc',
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }]
    }))
  })
}

// Seed: two related notes in a folder, one with enhanced notes + transcript.
const econ = createFolder('Econ')
const a = createMeeting().id
updateTitle(a, 'Fiscal policy: a lecture')
setMeetingFolder(a, econ.id)
saveNotes(a, doc('multipliers matter', 'crowding out is contested'))
insertSegment(a, 'mic', 'let us discuss multipliers', 1_000, 3_000)
insertSegment(a, 'system', 'the empirical estimates vary widely', 4_000, 7_000, 0)
saveEnhanced(
  a,
  '{}',
  '# Fiscal policy: a lecture\n\n- ⟦U⟧multipliers matter⟦/U⟧ — estimates range 0.5–2.5\n\n## Decisions\n- Read Ramey (2019)\n'
)
reindexMeeting(a)
saveNoteEntities(a, [
  { name: 'Fiscal Multiplier', kind: 'concept', weight: 0.9 },
  { name: 'Crowding Out', kind: 'concept', weight: 0.6 }
])

const b = createMeeting().id
updateTitle(b, 'Seminar on multipliers')
setMeetingFolder(b, econ.id)
saveNotes(b, doc('ramey survey walkthrough'))
reindexMeeting(b)
saveNoteEntities(b, [{ name: 'Fiscal Multiplier', kind: 'concept', weight: 0.8 }])

// ---------------------------------------------------------------------------
header('noteToMarkdown')
// ---------------------------------------------------------------------------

const meetingA = getMeeting(a)!
const md = noteToMarkdown(meetingA, getSegments(a), {
  transcript: true,
  frontmatter: true,
  wikilinks: false
})
result('frontmatter carries id and title', md.startsWith('---\n') && md.includes(`id: ${a}`))
result('sentinels stripped', !md.includes('⟦U⟧') && md.includes('multipliers matter'))
result('single H1 (stored title line dropped)', md.match(/^# /gm)?.length === 1)
result('rough notes and transcript sections present', md.includes('## My notes') && md.includes('## Transcript') && md.includes('**Me**: let us discuss multipliers'))
result('concepts listed', md.includes('Concepts: Fiscal Multiplier · Crowding Out'))
result('safeName strips link/path syntax', safeName('a/b: [c] #d|e', 'x') === 'a b c d e')
result('stripSentinels sweeps half-emitted markers', stripSentinels('a ⟦/U⟦ b ⟧ c') === 'a  b  c')

// ---------------------------------------------------------------------------
header('Obsidian vault')
// ---------------------------------------------------------------------------

const vault = buildVault(null)
const paths = vault.map((f) => f.path).sort()
result(
  'vault layout: folder dirs + concept stubs',
  paths.includes('Econ/Fiscal policy a lecture.md') &&
    paths.includes('Econ/Seminar on multipliers.md') &&
    paths.includes('Concepts/Fiscal Multiplier.md'),
  paths.join(', ')
)
const noteFile = vault.find((f) => f.path === 'Econ/Fiscal policy a lecture.md')!
result(
  'notes wikilink their concepts and relations',
  noteFile.content.includes('[[Fiscal Multiplier]]') &&
    noteFile.content.includes('## Related') &&
    noteFile.content.includes('[[Seminar on multipliers]]')
)
const conceptFile = vault.find((f) => f.path === 'Concepts/Fiscal Multiplier.md')!
result(
  'concept stubs backlink every carrying note',
  conceptFile.content.includes('[[Fiscal policy a lecture]]') &&
    conceptFile.content.includes('[[Seminar on multipliers]]')
)

// ---------------------------------------------------------------------------
header('JSON bundle')
// ---------------------------------------------------------------------------

const bundle = JSON.parse(buildJsonBundle(null)) as {
  format: string
  version: number
  folders: { name: string }[]
  notes: {
    id: string
    enhancedMarkdown: string | null
    roughNotesMarkdown: string
    transcript: { speaker: string; text: string }[]
    concepts: { name: string }[]
    related: { id: string }[]
  }[]
}
result('bundle self-describes', bundle.format === 'granola-clone-library' && bundle.version === 1)
const bundleA = bundle.notes.find((n) => n.id === a)!
result(
  'bundle carries markdown, transcript, concepts, relations',
  bundleA.enhancedMarkdown!.includes('multipliers matter') &&
    !bundleA.enhancedMarkdown!.includes('⟦U⟧') &&
    bundleA.roughNotesMarkdown.includes('crowding out') &&
    bundleA.transcript[0].speaker === 'Me' &&
    bundleA.concepts.some((c) => c.name === 'Fiscal Multiplier') &&
    bundleA.related.some((r) => r.id === b)
)

// ---------------------------------------------------------------------------
header('DOCX container')
// ---------------------------------------------------------------------------

const docx = markdownToDocx(
  '# Title\n\nBody with **bold** and `code`.\n\n- item one\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n```js\nconst x = 1\n```'
)
result('zip magic + EOCD present', docx.readUInt32LE(0) === 0x04034b50 && docx.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])))
// Prove the container is a real zip by unzipping it with the system tool.
const workDir = mkdtempSync(join(tmpdir(), 'docx-'))
const docxPath = join(workDir, 'note.docx')
writeFileSync(docxPath, docx)
execFileSync('unzip', ['-o', '-q', docxPath, '-d', join(workDir, 'x')])
const unzipped = readdirSync(join(workDir, 'x'), { recursive: true }) as string[]
result(
  'unzip accepts the container and finds the OOXML parts',
  unzipped.includes('word/document.xml') && unzipped.includes('[Content_Types].xml'),
  unzipped.join(', ')
)
const docXml = readFileSync(join(workDir, 'x/word/document.xml'), 'utf8')
result(
  'document.xml carries styles, lists, and runs',
  docXml.includes('Heading1') &&
    docXml.includes('<w:numPr>') &&
    docXml.includes('<w:b/>') &&
    docXml.includes('const x = 1')
)
result('xml escapes note text', markdownToDocx('a < b & c > d').includes('a &lt; b &amp; c &gt; d'))
result('buildZip empty input yields a valid empty archive', buildZip([]).length === 22)

// ---------------------------------------------------------------------------
header('HTML + Notion conversion')
// ---------------------------------------------------------------------------

const html = markdownToHtmlDocument('T & T', 'sub<script>', '# H\n\nBody <img src=x onerror=alert(1)>')
result(
  'html escapes title, subtitle, and raw html in notes',
  html.includes('<title>T &amp; T</title>') &&
    html.includes('sub&lt;script&gt;') &&
    !html.includes('<img src=x')
)

const blocks = markdownToNotionBlocks(
  '# Head\n\npara with **bold**\n\n- one\n  - nested\n\n1. num\n\n> quote\n\n```py\nx=1\n```'
)
const types = blocks.map((block) => block.type)
result(
  'notion block types map',
  types.join(',') === 'heading_1,paragraph,bulleted_list_item,numbered_list_item,quote,code',
  types.join(',')
)
const bullet = blocks.find((block) => block.type === 'bulleted_list_item') as unknown as {
  bulleted_list_item: { children?: unknown[] }
}
result('nested list becomes children', (bullet.bulleted_list_item.children?.length ?? 0) > 0)
const longBlocks = markdownToNotionBlocks(`para ${'x'.repeat(4500)}`)
const rich = (
  longBlocks[0] as unknown as { paragraph: { rich_text: { text: { content: string } }[] } }
).paragraph.rich_text
result(
  'rich_text split under the 2000-char cap',
  rich.length >= 3 && rich.every((r) => r.text.content.length <= 2000)
)

result(
  'normalizePageId accepts raw, dashed, and URL forms',
  normalizePageId('0123456789abcdef0123456789abcdef') === '01234567-89ab-cdef-0123-456789abcdef' &&
    normalizePageId('https://notion.so/Page-0123456789abcdef0123456789abcdef?x=1') ===
      '01234567-89ab-cdef-0123-456789abcdef'
)
