import { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { UserTextMark } from '../../editor/userTextMark'
import { markdownToHtml } from '../../editor/markdownToDoc'

const PROSE_CLASS =
  'prose prose-stone prose-sm max-w-none focus:outline-none ' +
  'prose-headings:font-semibold prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0'

/** Editable render of the saved enhanced doc (user text black, AI text gray).
 *  Edits autosave (debounced) back to the meeting's enhanced_json. */
export function EnhancedDoc({
  meetingId,
  docJson
}: {
  meetingId: string
  docJson: string
}): React.JSX.Element {
  const content = useMemo(() => {
    try {
      return JSON.parse(docJson) as object
    } catch {
      return undefined
    }
  }, [docJson])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useEditor(
    {
      extensions: [StarterKit, UserTextMark],
      content,
      editorProps: { attributes: { class: PROSE_CLASS } },
      onUpdate: ({ editor }) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          void window.api.invoke('enhanced:save', meetingId, JSON.stringify(editor.getJSON()))
        }, 750)
      }
    },
    [docJson]
  )

  // Flush any pending save when leaving the note or before a remount
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        if (editor) {
          void window.api.invoke('enhanced:save', meetingId, JSON.stringify(editor.getJSON()))
        }
      }
    }
  }, [editor, meetingId])

  return (
    <div className="enhanced-doc cursor-text" onClick={() => editor?.chain().focus().run()}>
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
