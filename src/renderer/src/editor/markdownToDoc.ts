import { generateJSON } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { marked } from 'marked'
import { UserTextMark } from './userTextMark'

const U_OPEN = '⟦U⟧'
const U_CLOSE = '⟦/U⟧'

const SPAN_OPEN = '<span data-user-text="true">'

export function markdownToHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false })
  // Convert sentinels to spans after markdown rendering, so markers survive
  // inline formatting. Browsers auto-balance spans that cross block edges.
  // Inside <pre>/<code> a span would be invalid markup — drop the markers there.
  const out = html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/)
    .map((part, i) =>
      i % 2 === 1
        ? part.replaceAll(U_OPEN, '').replaceAll(U_CLOSE, '')
        : part.replaceAll(U_OPEN, SPAN_OPEN).replaceAll(U_CLOSE, '</span>')
    )
    .join('')
  // A dangling ⟦U⟧ (model never closed it) would leave an unbalanced span.
  const opens = out.split(SPAN_OPEN).length - 1
  const closes = out.split('</span>').length - 1
  return opens > closes ? out + '</span>'.repeat(opens - closes) : out
}

/** Convert Claude's enhanced markdown (with ⟦U⟧ sentinels) into ProseMirror JSON. */
export function enhancedMarkdownToDoc(markdown: string): object {
  const html = markdownToHtml(markdown)
  return generateJSON(html, [StarterKit, UserTextMark])
}

/** Strip the title H1 (first line) Claude emits; we surface it as the meeting title. */
export function splitTitle(markdown: string): { title: string | null; body: string } {
  const lines = markdown.split('\n')
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1) return { title: null, body: markdown }
  const m = lines[first].match(/^#\s+(.+)$/)
  if (!m) return { title: null, body: markdown }
  const title = m[1].replaceAll(U_OPEN, '').replaceAll(U_CLOSE, '').trim()
  return { title, body: lines.slice(first + 1).join('\n').trimStart() }
}
