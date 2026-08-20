import { useEffect, useRef, useState } from 'react'

type Item = { label: string; hint?: string; action: () => Promise<string | null> }

/** Dropdown of export actions. Each action resolves to a status line (or null
 *  when the user cancelled a dialog); the line shows briefly under the button. */
export default function ExportMenu({
  items,
  compact
}: {
  items: Item[]
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  async function runItem(item: Item): Promise<void> {
    setOpen(false)
    setBusy(true)
    setStatus(`${item.label}…`)
    try {
      const line = await item.action()
      setStatus(line)
      if (line) setTimeout(() => setStatus(null), 6000)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70 disabled:opacity-40 ${compact ? '' : ''}`}
      >
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => void runItem(item)}
              className="block w-full px-3 py-1.5 text-left text-sm text-stone-700 hover:bg-stone-100"
            >
              {item.label}
              {item.hint && <span className="block text-xs text-stone-400">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {status && !open && (
        <div className="absolute top-full right-0 z-50 mt-1 max-w-xs rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs break-words text-stone-600 shadow-lg">
          {status}
        </div>
      )}
    </div>
  )
}
