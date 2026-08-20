// Standalone HTML export — one self-contained file, no external assets, so it
// opens anywhere and doubles as the PDF's print source.
import { Marked } from 'marked'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Same hardening as the renderer's markdown pipeline: note text can contain
// model output and spoken words; raw HTML in it is escaped, never passed
// through into a document the user will open in a browser.
const safeMarked = new Marked({ gfm: true, breaks: false })
safeMarked.use({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text)
    }
  }
})

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.5rem 5rem;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: #292524; background: #fff; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 1rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.6rem; border-bottom: 1px solid #e7e5e4; padding-bottom: 0.3rem; }
  h3 { font-size: 1rem; margin: 1.4rem 0 0.4rem; }
  p, li { margin: 0.35rem 0; }
  ul, ol { padding-left: 1.4rem; }
  blockquote { margin: 0.8rem 0; padding: 0.1rem 1rem; border-left: 3px solid #d6d3d1; color: #57534e; }
  code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #f5f5f4; border-radius: 4px; padding: 0.1em 0.35em; }
  pre { background: #f5f5f4; border-radius: 8px; padding: 0.8rem 1rem; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #e7e5e4; margin: 2rem 0; }
  a { color: #b45309; }
  .meta { color: #a8a29e; font-size: 0.82rem; margin-bottom: 2rem; }
`

/** Note markdown → a complete standalone HTML document. */
export function markdownToHtmlDocument(title: string, subtitle: string, markdown: string): string {
  const body = safeMarked.parse(markdown, { async: false }) as string
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="meta">${escapeHtml(subtitle)}</div>
${body}
</body>
</html>
`
}
