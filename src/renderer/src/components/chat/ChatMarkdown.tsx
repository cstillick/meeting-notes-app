import { useMemo, useState } from 'react'
import { Marked } from 'marked'

// Own Marked instance: marked's default export is a shared singleton also used
// by the enhance pipeline (markdownToDoc), and we override the html renderer.
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const chatMarked = new Marked({ gfm: true, breaks: false })
chatMarked.use({
  renderer: {
    // Model output is injected via innerHTML — neutralize any raw HTML it
    // emits (block and inline tags both land here) instead of trusting it.
    html({ text }) {
      return escapeHtml(text)
    }
  }
})

const PROSE_CLASS =
  'chat-md prose prose-stone prose-sm max-w-none ' +
  'prose-headings:font-semibold prose-headings:text-stone-700 ' +
  'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 ' +
  'prose-strong:text-stone-800 prose-code:text-[0.85em] prose-pre:bg-stone-800'

export function ChatMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  const html = useMemo(() => {
    try {
      return chatMarked.parse(markdown, { async: false })
    } catch {
      return escapeHtml(markdown)
    }
  }, [markdown])

  return <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
}

/** Hover-revealed copy button; copies the raw markdown of an answer. */
export function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={() => void copy()}
      className={`rounded px-1.5 py-0.5 text-[11px] transition-opacity ${
        copied
          ? 'text-green-600 opacity-100'
          : 'text-stone-400 opacity-0 group-hover:opacity-100 hover:bg-stone-100 hover:text-stone-600'
      }`}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
