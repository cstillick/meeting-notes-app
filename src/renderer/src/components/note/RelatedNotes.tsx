import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RelatedNote } from '@shared/types'

/** Notes tied to this one through shared knowledge-graph concepts. Renders
 *  nothing until the graph has something to say — extraction runs in the
 *  background, so most notes gain relations a minute after they get content. */
export default function RelatedNotes({ meetingId }: { meetingId: string }): React.JSX.Element | null {
  const [related, setRelated] = useState<RelatedNote[]>([])

  useEffect(() => {
    let cancelled = false
    void window.api.invoke('graph:related', meetingId).then((notes) => {
      if (!cancelled) setRelated(notes)
    })
    const off = window.api.on('graph:changed', () => {
      void window.api.invoke('graph:related', meetingId).then((notes) => {
        if (!cancelled) setRelated(notes)
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [meetingId])

  if (related.length === 0) return null

  return (
    <section className="mt-10 border-t border-stone-200 pt-4">
      <h2 className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
        Related notes
      </h2>
      <ul className="mt-2 space-y-1.5">
        {related.map((r) => (
          <li key={r.id}>
            <Link
              to={`/note/${r.id}`}
              className="group block rounded-md px-2 py-1.5 hover:bg-stone-100"
            >
              <span className="text-sm font-medium text-stone-700 group-hover:text-stone-900">
                {r.title || 'Untitled note'}
              </span>
              <span className="ml-2 text-xs text-stone-400">via {r.shared.join(', ')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
