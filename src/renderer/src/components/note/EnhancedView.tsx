import { useCallback, useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { UserTextMark } from '../../editor/userTextMark'
import { markdownToHtml } from '../../editor/markdownToDoc'
import { registerFlush } from '../../flush'

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

  const flush = useCallback((): Promise<unknown> | undefined => {
    if (!saveTimer.current) return undefined
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (editor) {
      return window.api.invoke('enhanced:save', meetingId, JSON.stringify(editor.getJSON()))
    }
    return undefined
  }, [editor, meetingId])

  // Flush any pending save when leaving the note, on window teardown
  // (pagehide), and on quit — app.exit skips pagehide, hence the registry.
  useEffect(() => {
    const onPagehide = (): void => void flush()
    window.addEventListener('pagehide', onPagehide)
    const unregister = registerFlush(flush)
    return () => {
      window.removeEventListener('pagehide', onPagehide)
      unregister()
      void flush()
    }
  }, [flush])

  return (
    <div className="enhanced-doc cursor-text" onClick={() => editor?.chain().focus().run()}>
      <EditorContent editor={editor} />
    </div>
  )
}

/** Read-only render of markdown that never reached a saved doc — the streaming
 *  preview and the kept-but-unsaved partial after a failed enhancement. */
export function MarkdownPreview({ markdown }: { markdown: string }): React.JSX.Element {
  const html = useMemo(() => {
    try {
      return markdownToHtml(markdown)
    } catch {
      return ''
    }
  }, [markdown])

  return <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
}

/** Lightweight live preview while markdown is still streaming in. */
export function StreamingPreview({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <div className="enhanced-doc">
      <MarkdownPreview markdown={markdown} />
      <span className="mt-2 inline-block h-4 w-2 animate-pulse bg-amber-500" />
    </div>
  )
}
