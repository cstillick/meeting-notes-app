import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { GraphData, GraphNode } from '@shared/types'
import { useLibraryStore } from '../../stores/libraryStore'

// Hand-rolled force layout — no dependency needed for a few hundred nodes.
// Physics run in refs (per-frame mutation would fight React); React owns the
// chrome around the canvas.

interface SimNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

interface SimLink {
  a: SimNode
  b: SimNode
  weight: number
}

const KIND_COLOR: Record<GraphNode['kind'], string> = {
  note: '#d97706', // amber-600
  concept: '#0284c7', // sky-600
  topic: '#7c3aed', // violet-600
  person: '#059669', // emerald-600
  organization: '#e11d48' // rose-600
}

/** Above this many nodes the sim and the eye both give out; keep the
 *  highest-degree entities and every note. */
const MAX_NODES = 600

function buildSim(data: GraphData): { nodes: SimNode[]; links: SimLink[] } {
  let nodes = data.nodes
  if (nodes.length > MAX_NODES) {
    const notes = nodes.filter((n) => n.kind === 'note')
    const entities = nodes
      .filter((n) => n.kind !== 'note')
      .sort((a, b) => b.degree - a.degree)
      .slice(0, Math.max(0, MAX_NODES - notes.length))
    nodes = [...notes, ...entities]
  }
  const simNodes = nodes.map<SimNode>((n, i) => {
    // Deterministic spiral seed: stable layouts across reloads beat random.
    const angle = i * 2.399963 // golden angle
    const radius = 18 * Math.sqrt(i + 1)
    return {
      ...n,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: n.kind === 'note' ? 6 + Math.min(6, n.degree) : 4 + Math.min(10, n.degree * 1.5)
    }
  })
  const byId = new Map(simNodes.map((n) => [n.id, n]))
  const links: SimLink[] = []
  for (const l of data.links) {
    const a = byId.get(l.source)
    const b = byId.get(l.target)
    if (a && b) links.push({ a, b, weight: l.weight })
  }
  return { nodes: simNodes, links }
}

function tick(nodes: SimNode[], links: SimLink[], alpha: number): void {
  // Repulsion (capped-range n²; fine at this scale).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 === 0) {
        dx = (Math.random() - 0.5) * 0.1
        dy = (Math.random() - 0.5) * 0.1
        d2 = dx * dx + dy * dy
      }
      if (d2 > 250 * 250) continue
      const d = Math.sqrt(d2)
      const force = (900 / d2) * alpha
      const fx = (dx / d) * force
      const fy = (dy / d) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }
  // Springs.
  for (const { a, b, weight } of links) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const rest = 70 - 25 * Math.min(1, weight)
    const force = (d - rest) * 0.04 * alpha
    const fx = (dx / d) * force
    const fy = (dy / d) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }
  // Gravity toward origin + integrate with damping.
  for (const n of nodes) {
    n.vx -= n.x * 0.003 * alpha
    n.vy -= n.y * 0.003 * alpha
    n.vx *= 0.85
    n.vy *= 0.85
    n.x += n.vx
    n.y += n.vy
  }
}

export default function GraphView(): React.JSX.Element {
  const navigate = useNavigate()
  const folders = useLibraryStore((s) => s.folders)
  const refreshFolders = useLibraryStore((s) => s.refreshFolders)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [data, setData] = useState<GraphData | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<{ nodes: SimNode[]; links: SimLink[] }>({ nodes: [], links: [] })
  const alphaRef = useRef(1)
  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const hoverRef = useRef<SimNode | null>(null)
  const selectedRef = useRef<SimNode | null>(null)
  const dragRef = useRef<{ node: SimNode | null; panning: boolean; lastX: number; lastY: number }>(
    { node: null, panning: false, lastX: 0, lastY: 0 }
  )

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  const load = useCallback(async () => {
    const graph = await window.api.invoke('graph:get', folderId)
    setData(graph)
    simRef.current = buildSim(graph)
    alphaRef.current = 1
    setSelected(null)
    selectedRef.current = null
  }, [folderId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return window.api.on('graph:changed', () => void load())
  }, [load])

  // Render + physics loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const draw = (): void => {
      const { nodes, links } = simRef.current
      if (alphaRef.current > 0.005) {
        tick(nodes, links, alphaRef.current)
        alphaRef.current *= 0.985
      }
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }
      const view = viewRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.translate(width / 2 + view.x, height / 2 + view.y)
      ctx.scale(view.scale, view.scale)

      const hover = hoverRef.current
      const sel = selectedRef.current
      const focus = sel ?? hover
      const neighbors = new Set<string>()
      if (focus) {
        neighbors.add(focus.id)
        for (const l of links) {
          if (l.a.id === focus.id) neighbors.add(l.b.id)
          if (l.b.id === focus.id) neighbors.add(l.a.id)
        }
      }

      for (const l of links) {
        const lit = focus && (l.a.id === focus.id || l.b.id === focus.id)
        ctx.strokeStyle = lit ? 'rgba(217,119,6,0.55)' : 'rgba(120,113,108,0.16)'
        ctx.lineWidth = (lit ? 1.6 : 0.7) / view.scale
        ctx.beginPath()
        ctx.moveTo(l.a.x, l.a.y)
        ctx.lineTo(l.b.x, l.b.y)
        ctx.stroke()
      }

      for (const n of nodes) {
        const dimmed = focus !== null && !neighbors.has(n.id)
        ctx.globalAlpha = dimmed ? 0.18 : 1
        ctx.fillStyle = KIND_COLOR[n.kind]
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
        if (n.id === sel?.id || n.id === hover?.id) {
          ctx.strokeStyle = '#292524'
          ctx.lineWidth = 1.5 / view.scale
          ctx.stroke()
        }
      }

      // Labels: entities above a degree floor, everything near focus, and the
      // hovered node — scaled so text stays readable while zooming.
      ctx.globalAlpha = 1
      const fontPx = Math.max(9, 11 / view.scale)
      ctx.font = `${fontPx}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      for (const n of nodes) {
        const isFocus = n.id === hover?.id || n.id === sel?.id
        const nearFocus = focus !== null && neighbors.has(n.id)
        const labelled =
          isFocus || nearFocus || (n.kind !== 'note' ? n.degree >= 2 : view.scale > 1.4)
        if (!labelled) continue
        const dimmed = focus !== null && !neighbors.has(n.id)
        if (dimmed) continue
        ctx.fillStyle = isFocus ? '#1c1917' : 'rgba(68,64,60,0.85)'
        const label = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label
        ctx.fillText(label, n.x, n.y - n.r - 4 / view.scale)
      }
      ctx.restore()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const view = viewRef.current
    return {
      x: (clientX - rect.left - rect.width / 2 - view.x) / view.scale,
      y: (clientY - rect.top - rect.height / 2 - view.y) / view.scale
    }
  }, [])

  const pick = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const { x, y } = toWorld(clientX, clientY)
      let best: SimNode | null = null
      let bestD = Infinity
      for (const n of simRef.current.nodes) {
        const d = Math.hypot(n.x - x, n.y - y)
        if (d < n.r + 6 / viewRef.current.scale && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    },
    [toWorld]
  )

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const node = pick(e.clientX, e.clientY)
    dragRef.current = { node, panning: node === null, lastX: e.clientX, lastY: e.clientY }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag.node) {
      const { x, y } = toWorld(e.clientX, e.clientY)
      drag.node.x = x
      drag.node.y = y
      drag.node.vx = 0
      drag.node.vy = 0
      alphaRef.current = Math.max(alphaRef.current, 0.25)
    } else if (drag.panning) {
      viewRef.current.x += e.clientX - drag.lastX
      viewRef.current.y += e.clientY - drag.lastY
      drag.lastX = e.clientX
      drag.lastY = e.clientY
    } else {
      hoverRef.current = pick(e.clientX, e.clientY)
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    const moved = Math.hypot(e.clientX - drag.lastX, e.clientY - drag.lastY) > 4
    if (drag.node && !moved) {
      if (drag.node.kind === 'note') {
        navigate(`/note/${drag.node.id.slice(2)}`)
      } else {
        const same = selectedRef.current?.id === drag.node.id
        selectedRef.current = same ? null : drag.node
        setSelected(same ? null : drag.node)
      }
    } else if (drag.panning && !moved) {
      selectedRef.current = null
      setSelected(null)
    }
    dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 }
  }

  const onWheel = (e: React.WheelEvent): void => {
    const view = viewRef.current
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(5, Math.max(0.2, view.scale * factor))
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    // Zoom around the cursor.
    view.x = cx - ((cx - view.x) / view.scale) * next
    view.y = cy - ((cy - view.y) / view.scale) * next
    view.scale = next
  }

  async function rebuild(): Promise<void> {
    if (!confirm('Re-extract concepts for every note? This reruns AI extraction on the whole library.')) return
    setRebuilding(true)
    try {
      await window.api.invoke('graph:rebuild')
    } finally {
      setTimeout(() => setRebuilding(false), 3000)
    }
  }

  const selectedNotes = useMemo(() => {
    if (!selected || !data) return []
    const noteIds = new Set(
      data.links.filter((l) => l.target === selected.id).map((l) => l.source)
    )
    return data.nodes.filter((n) => noteIds.has(n.id))
  }, [selected, data])

  const empty = data !== null && data.nodes.length === 0

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center gap-3 border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-700">
          ←
        </Link>
        <h1 className="text-sm font-semibold tracking-wide text-stone-500">Knowledge graph</h1>
        <select
          value={folderId ?? ''}
          onChange={(e) => setFolderId(e.target.value || null)}
          className="rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-600"
        >
          <option value="">All notes</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <span className="text-xs text-stone-400">
          {data ? `${data.nodes.filter((n) => n.kind === 'note').length} notes · ${data.nodes.filter((n) => n.kind !== 'note').length} concepts` : ''}
        </span>
        <button
          onClick={() => void rebuild()}
          disabled={rebuilding}
          className="rounded-md px-2.5 py-1.5 text-sm text-stone-500 hover:bg-stone-200/70 disabled:opacity-40"
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild'}
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none bg-stone-50"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        />

        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-sm text-center text-stone-400">
              <p className="text-lg font-medium">No graph yet</p>
              <p className="mt-1 text-sm">
                Concepts are extracted from your notes automatically (an Anthropic API key must be
                set). Give it a minute after recording or importing — or hit Rebuild.
              </p>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 left-4 flex gap-3 text-[11px] text-stone-400">
          {(['note', 'concept', 'topic', 'person', 'organization'] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
              {k}
            </span>
          ))}
        </div>

        {selected && (
          <aside className="absolute top-3 right-3 max-h-[70%] w-64 overflow-y-auto rounded-lg border border-stone-200 bg-white/95 p-3 shadow-lg">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-stone-800">{selected.label}</h2>
              <span className="text-[10px] tracking-wide text-stone-400 uppercase">
                {selected.kind}
              </span>
            </div>
            <p className="mt-1 text-xs text-stone-400">
              {selectedNotes.length} note{selectedNotes.length === 1 ? '' : 's'}
            </p>
            <ul className="mt-2 space-y-1">
              {selectedNotes.map((n) => (
                <li key={n.id}>
                  <Link
                    to={`/note/${n.id.slice(2)}`}
                    className="block truncate rounded px-1.5 py-1 text-sm text-stone-700 hover:bg-stone-100"
                  >
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}
