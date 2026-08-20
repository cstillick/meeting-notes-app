// Serializes the enhanced-notes ProseMirror document (StarterKit + UserTextMark)
// back to Markdown. enhanced_md is the canonical text every consumer reads —
// MCP get_note, chat excerpts, the FTS body, chunk sections — so a manual edit
// in the editor must round-trip structure (headings, lists, emphasis, ⟦U⟧
// provenance marks). Flattening to plain lines is a one-way loss: nothing else
// in the app can reconstruct Markdown from the flattened text.
//
// Electron-free on purpose: the stress suite imports this under plain Node.

interface PmMark {
  type: string
  attrs?: Record<string, unknown>
}

interface PmNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: PmMark[]
  content?: PmNode[]
}

const U_OPEN = '⟦U⟧'
const U_CLOSE = '⟦/U⟧'

/** Outer wrappers first; inner marks bind tighter. userText is outermost so
 *  the sentinels enclose the whole styled span, matching how markdownToHtml
 *  produced the span in the first place. */
const MARK_ORDER = ['userText', 'link', 'bold', 'italic', 'strike', 'underline', 'code']

function markKey(marks: PmMark[] | undefined): string {
  return (marks ?? [])
    .map((m) => m.type + (m.type === 'link' ? `:${String(m.attrs?.href ?? '')}` : ''))
    .sort()
    .join('|')
}

function wrapMarks(text: string, marks: PmMark[]): string {
  if (!text) return text
  const ordered = [...marks].sort(
    (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type)
  )
  let out = text
  for (let i = ordered.length - 1; i >= 0; i--) {
    switch (ordered[i].type) {
      case 'bold':
        out = `**${out}**`
        break
      case 'italic':
        out = `*${out}*`
        break
      case 'strike':
        out = `~~${out}~~`
        break
      case 'code':
        out = `\`${out}\``
        break
      case 'underline':
        // Markdown has no underline; raw HTML survives marked and parses back
        // to the underline mark on the next markdown→doc conversion.
        out = `<u>${out}</u>`
        break
      case 'link':
        out = `[${out}](${String(ordered[i].attrs?.href ?? '')})`
        break
      case 'userText':
        out = `${U_OPEN}${out}${U_CLOSE}`
        break
      default:
        break
    }
  }
  return out
}

/** Serialize a run of inline nodes. Consecutive text nodes with identical mark
 *  sets merge before wrapping, so "wo" + "rd" under bold emits `**word**`, not
 *  `**wo****rd**`. */
function inlineText(nodes: PmNode[] | undefined): string {
  if (!nodes) return ''
  const parts: string[] = []
  let run: PmNode[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const text = run.map((n) => n.text ?? '').join('')
    parts.push(wrapMarks(text, run[0].marks ?? []))
    run = []
  }
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      flush()
      parts.push('\n')
      continue
    }
    if (typeof n.text !== 'string') {
      flush()
      parts.push(inlineText(n.content))
      continue
    }
    if (run.length > 0 && markKey(run[0].marks) !== markKey(n.marks)) flush()
    run.push(n)
  }
  flush()
  return parts.join('')
}

/** One list, as lines. 2-space indent per nesting level — the same convention
 *  the enhancement prompt demands of the model, so round-tripped documents look
 *  like first-generation ones. */
function serializeList(node: PmNode, ordered: boolean, indent: string): string[] {
  const lines: string[] = []
  let num = typeof node.attrs?.start === 'number' ? (node.attrs.start as number) : 1
  for (const item of node.content ?? []) {
    const marker = ordered ? `${num++}. ` : '- '
    const continuation = indent + ' '.repeat(marker.length)
    let firstLine: string | null = null
    const rest: string[] = []
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        rest.push(...serializeList(child, child.type === 'orderedList', indent + '  '))
      } else if (child.type === 'paragraph' || child.type === 'heading') {
        const text = inlineText(child.content).replace(/\n/g, `\n${continuation}`)
        if (firstLine === null) firstLine = text
        else rest.push(continuation + text)
      } else {
        for (const block of serializeBlock(child, indent + '  ')) rest.push(block)
      }
    }
    lines.push(indent + marker + (firstLine ?? ''))
    lines.push(...rest)
  }
  return lines
}

/** One block node as complete block strings (a list is one multi-line block). */
function serializeBlock(node: PmNode, indent = ''): string[] {
  switch (node.type) {
    case 'paragraph': {
      const t = inlineText(node.content)
      return t.trim() ? [indent + t.replace(/\n/g, '\n' + indent)] : []
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      return [`${indent}${'#'.repeat(level)} ${inlineText(node.content)}`]
    }
    case 'bulletList':
      return [serializeList(node, false, indent).join('\n')]
    case 'orderedList':
      return [serializeList(node, true, indent).join('\n')]
    case 'blockquote': {
      const inner = (node.content ?? []).flatMap((c) => serializeBlock(c))
      const quoted = inner
        .map((b) =>
          b
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
        )
        .join('\n>\n')
      return quoted
        ? [
            indent
              ? quoted
                  .split('\n')
                  .map((l) => indent + l)
                  .join('\n')
              : quoted
          ]
        : []
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      const text = (node.content ?? []).map((c) => c.text ?? '').join('')
      return [`${indent}\`\`\`${lang}\n${text}\n${indent}\`\`\``]
    }
    case 'horizontalRule':
      return [`${indent}---`]
    default: {
      // Unknown block type: salvage its text rather than dropping content.
      const t = inlineText(node.content)
      return t.trim() ? [indent + t] : []
    }
  }
}

/** Enhanced-doc JSON → Markdown. Returns '' when the JSON does not parse —
 *  callers fall back rather than persisting an empty document. */
export function pmToMarkdown(docJson: string): string {
  try {
    const doc = JSON.parse(docJson) as PmNode
    return (doc.content ?? []).flatMap((n) => serializeBlock(n)).join('\n\n')
  } catch (err) {
    console.error('pmToMarkdown: failed to serialize enhanced doc', err)
    return ''
  }
}
