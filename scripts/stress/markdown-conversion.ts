// Node-safe half of the markdown pipeline: markdownToHtml (sentinel handling)
// and splitTitle. enhancedMarkdownToDoc needs a DOM and is tested in the app.
// Run: STRESS_USERDATA_DIR=$(mktemp -d) node --import ./scripts/stress/_register.mjs scripts/stress/markdown-conversion.ts
import { markdownToHtml, splitTitle } from '../../src/renderer/src/editor/markdownToDoc.ts'
import { header, result } from './_util.ts'

header('markdownToHtml: sentinel placement')
const cases: { name: string; md: string; check: (html: string) => boolean; note: string }[] = [
  {
    name: 'plain sentinel',
    md: 'before ⟦U⟧user text⟦/U⟧ after',
    check: (h) => h.includes('<span data-user-text="true">user text</span>'),
    note: 'span wraps user text'
  },
  {
    name: 'sentinel inside heading',
    md: '## Heading ⟦U⟧mine⟦/U⟧',
    check: (h) => h.includes('data-user-text'),
    note: 'survives heading'
  },
  {
    name: 'sentinel inside inline code',
    md: 'run `⟦U⟧rm -rf⟦/U⟧` now',
    check: (h) => !h.match(/<code>.*<span/s),
    note: 'BUG if span injected inside <code>'
  },
  {
    name: 'sentinel inside fenced code',
    md: '```\n⟦U⟧const x = 1⟦/U⟧\n```',
    check: (h) => !h.match(/<pre>.*<span data-user-text/s),
    note: 'BUG if span injected inside <pre>'
  },
  {
    name: 'unbalanced open sentinel',
    md: 'hello ⟦U⟧dangling open',
    check: (h) => (h.match(/<span/g) ?? []).length === (h.match(/<\/span>/g) ?? []).length,
    note: 'BUG if unbalanced span emitted'
  },
  {
    name: 'sentinel spans block boundary',
    md: '⟦U⟧para one\n\npara two⟦/U⟧',
    check: (h) => (h.match(/<span/g) ?? []).length === (h.match(/<\/span>/g) ?? []).length,
    note: 'BUG if span crosses block edge unbalanced'
  },
  {
    name: 'sentinel in link text',
    md: '[⟦U⟧click⟦/U⟧](https://x.com)',
    check: (h) => h.includes('<a') && h.includes('data-user-text'),
    note: 'survives links'
  },
  {
    name: 'gfm table renders',
    md: '| a | b |\n|---|---|\n| 1 | 2 |',
    check: (h) => h.includes('<table>'),
    note: 'marked emits table (StarterKit has no table node → flattening expected downstream)'
  }
]
for (const c of cases) {
  const html = markdownToHtml(c.md)
  const ok = c.check(html)
  result(c.name, ok, c.note)
  if (!ok) console.log(`         html: ${JSON.stringify(html)}`)
}

header('splitTitle')
const t1 = splitTitle('# My Title\n\nBody here')
result('basic H1', t1.title === 'My Title' && t1.body.startsWith('Body'))
const t2 = splitTitle('\n\n# Late Title\nbody')
result('leading blank lines', t2.title === 'Late Title')
const t3 = splitTitle('No heading\n# mid-doc heading')
result('no H1 first line → null title', t3.title === null && t3.body.includes('mid-doc'))
const t4 = splitTitle('# ⟦U⟧User Title⟦/U⟧\nbody')
result('sentinels stripped from title', t4.title === 'User Title')
const t5 = splitTitle('## H2 only\nbody')
result('H2 is not a title', t5.title === null)
const t6 = splitTitle('')
result('empty input', t6.title === null && t6.body === '')
console.log('\nmarkdown-conversion complete')
