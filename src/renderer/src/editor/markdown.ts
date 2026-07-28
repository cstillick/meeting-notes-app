import { Marked } from 'marked'

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Own Marked instance rather than marked's shared singleton, so the html
// renderer can be overridden for every consumer at once: both sinks (chat
// answers in ChatMarkdown, enhanced notes in markdownToDoc) inject the result
// with dangerouslySetInnerHTML, and the CSP is the only other thing standing
// between an `<img src=x onerror=…>` in model output and the renderer.
const safeMarked = new Marked({ gfm: true, breaks: false })
safeMarked.use({
  renderer: {
    // Model output is injected via innerHTML — neutralize any raw HTML it
    // emits (block and inline tags both land here) instead of trusting it.
    html({ text }) {
      return escapeHtml(text)
    }
  }
})

/** Model markdown → HTML, with raw HTML in the source escaped rather than passed through. */
export function renderMarkdown(markdown: string): string {
  return safeMarked.parse(markdown, { async: false })
}
