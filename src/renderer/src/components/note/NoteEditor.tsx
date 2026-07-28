import { useCallback, useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { registerFlush } from '../../flush'

export default function NoteEditor({
  meetingId,
  initialContent
}: {
  meetingId: string
  initialContent: string
}): React.JSX.Element {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder:
            'Jot rough notes during the meeting — fragments are fine. AI will expand them using the transcript.'
        })
      ],
      content: parseContent(initialContent),
      editorProps: {
        attributes: {
          class:
            'prose prose-stone prose-sm max-w-none focus:outline-none min-h-[300px] ' +
            'prose-headings:font-semibold prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0'
        }
      },
      onUpdate: ({ editor }) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          void window.api.invoke('notes:save', meetingId, JSON.stringify(editor.getJSON()))
        }, 750)
      }
    },
    [meetingId]
  )

  const flush = useCallback((): Promise<unknown> | undefined => {
    if (!saveTimer.current) return undefined
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (editor) {
      return window.api.invoke('notes:save', meetingId, JSON.stringify(editor.getJSON()))
    }
    return undefined
  }, [editor, meetingId])

  // Flush any pending save when leaving the note. The window can also be torn
  // down without unmounting React (window close / quit), hence pagehide — and
  // quit itself skips pagehide entirely, hence the registry (see flush.ts).
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
    <div className="h-full cursor-text" onClick={() => editor?.chain().focus().run()}>
      <EditorContent editor={editor} />
    </div>
  )
}

function parseContent(json: string): object | undefined {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc') return parsed
  } catch {
    // fall through
  }
  return undefined
}
