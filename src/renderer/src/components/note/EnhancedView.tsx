import { useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { UserTextMark } from '../../editor/userTextMark'
import { markdownToHtml } from '../../editor/markdownToDoc'

const PROSE_CLASS =
  'prose prose-stone prose-sm max-w-none focus:outline-none ' +
  'prose-headings:font-semibold prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0'

/** Read-only render of the saved enhanced doc (user text black, AI text gray). */
export function EnhancedDoc({ docJson }: { docJson: string }): React.JSX.Element {
  const content = useMemo(() => {
    try {
      return JSON.parse(docJson) as object
    } catch {
      return undefined
    }
  }, [docJson])

  const editor = useEditor(
    {
      extensions: [StarterKit, UserTextMark],
      content,
      editable: false,
      editorProps: { attributes: { class: PROSE_CLASS } }
    },
    [docJson]
  )

  return (
    <div className="enhanced-doc">
      <EditorContent editor={editor} />
    </div>
  )
}

/** Lightweight live preview while markdown is still streaming in. */
export function StreamingPreview({ markdown }: { markdown: string }): React.JSX.Element {
  const html = useMemo(() => {
    try {
      return markdownToHtml(markdown)
    } catch {
      return ''
    }
  }, [markdown])

  return (
    <div className="enhanced-doc">
      <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
      <span className="mt-2 inline-block h-4 w-2 animate-pulse bg-amber-500" />
    </div>
  )
}
