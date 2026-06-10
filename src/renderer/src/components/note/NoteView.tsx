import { Link, useParams } from 'react-router-dom'

export default function NoteView(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center gap-3 border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-700">
          ← Back
        </Link>
        <span className="text-sm text-stone-400">Note {id}</span>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <p className="text-stone-400">Editor coming in Phase 4.</p>
      </main>
    </div>
  )
}
