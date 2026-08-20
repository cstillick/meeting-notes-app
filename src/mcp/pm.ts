// ProseMirror helpers for the MCP write path. Standalone on purpose (like
// db.ts): plain Node, no electron, no app imports.
//
// pmToText mirrors src/main/db/search.ts pmToText — the FTS body built here
// must tokenize the same as one built by the app. markdownToPmDoc emits the
// TipTap StarterKit node vocabulary the rough-notes editor uses (paragraph,
// heading, bulletList/orderedList/listItem, blockquote, codeBlock), so notes
// created by an agent open in the editor as ordinary editable documents.

interface PmMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface PmNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: PmMark[]
  content?: PmNode[]
}

/** Extract plain text from ProseMirror JSON (best-effort, for indexing).
 *  Iterative walk: depth is untrusted, recursion would overflow. */
export function pmToText(json: string): string {
  try {
    const parts: string[] = []
    const stack: unknown[] = [JSON.parse(json)]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      const n = node as { text?: string; content?: unknown[] }
      if (typeof n.text === 'string') parts.push(n.text)
      if (Array.isArray(n.content)) {
        for (let i = n.content.length - 1; i >= 0; i--) stack.push(n.content[i])
      }
    }
    return parts.join(' ')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Markdown → ProseMirror
// ---------------------------------------------------------------------------

/** Inline markdown → text nodes with marks. Handles **bold**, *italic* or
 *  _italic_, `code`, and [text](url); unclosed markers fall through as
 *  literal text. Single pass, no nesting — agent-written notes are prose,
 *  not typography. */
export function inlineToNodes(text: string): PmNode[] {
  const nodes: PmNode[] = []
  let plain = ''
  const flush = (): void => {
    if (plain) nodes.push({ type: 'text', text: plain })
    plain = ''
  }
  const push = (t: string, marks: PmMark[]): void => {
    if (t) nodes.push({ type: 'text', text: t, marks })
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpMatchArray | null
    if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush()
      push(m[1], [{ type: 'bold' }])
      i += m[0].length
    } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/)) || (m = rest.match(/^_([^_\s][^_]*?)_/))) {
      flush()
      push(m[1], [{ type: 'italic' }])
      i += m[0].length
    } else if ((m = rest.match(/^`([^`]+)`/))) {
      flush()
      push(m[1], [{ type: 'code' }])
      i += m[0].length
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush()
      push(m[1], [{ type: 'link', attrs: { href: m[2] } }])
      i += m[0].length
    } else {
      plain += text[i]
      i++
    }
  }
  flush()
  return nodes
}

function paragraph(text: string): PmNode {
  const inline = inlineToNodes(text)
  return inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' }
}

interface ListFrame {
  node: PmNode
  indent: number
  ordered: boolean
}

/** Markdown → ProseMirror block nodes. Line-oriented (each plain line becomes
 *  its own paragraph — notes are line-structured, and this round-trips with
 *  pmToPlainText), with headings, nested -/* and 1. lists at 2-space indents,
 *  > blockquotes, and ``` fences. Anything unrecognised survives as a
 *  paragraph of literal text. */
export function markdownToBlocks(markdown: string): PmNode[] {
  const blocks: PmNode[] = []
  const listStack: ListFrame[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let fence: { lang: string; lines: string[] } | null = null

  const closeListsTo = (indent: number): void => {
    while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent + 2) {
      listStack.pop()
    }
  }
  const closeAllLists = (): void => {
    listStack.length = 0
  }
  const topLevelPush = (node: PmNode): void => {
    blocks.push(node)
  }

  for (const raw of lines) {
    if (fence) {
      if (/^\s*```/.test(raw)) {
        const text = fence.lines.join('\n')
        topLevelPush({
          type: 'codeBlock',
          attrs: fence.lang ? { language: fence.lang } : {},
          content: text ? [{ type: 'text', text }] : []
        })
        fence = null
      } else {
        fence.lines.push(raw)
      }
      continue
    }
    const fenceOpen = raw.match(/^\s*```(\w*)\s*$/)
    if (fenceOpen) {
      closeAllLists()
      fence = { lang: fenceOpen[1], lines: [] }
      continue
    }

    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      closeAllLists()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeAllLists()
      topLevelPush({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineToNodes(heading[2])
      })
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeAllLists()
      const prev = blocks[blocks.length - 1]
      if (prev?.type === 'blockquote') {
        prev.content!.push(paragraph(quote[1]))
      } else {
        topLevelPush({ type: 'blockquote', content: [paragraph(quote[1])] })
      }
      continue
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeAllLists()
      topLevelPush({ type: 'horizontalRule' })
      continue
    }

    const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (item) {
      const indent = item[1].length
      const ordered = /\d/.test(item[2])
      closeListsTo(indent)
      let top = listStack[listStack.length - 1]
      if (!top || top.indent < indent || top.ordered !== ordered) {
        const listNode: PmNode = { type: ordered ? 'orderedList' : 'bulletList', content: [] }
        if (top && top.indent < indent) {
          // Nest under the last item of the enclosing list.
          const items = top.node.content!
          const parent = items[items.length - 1]
          if (parent) parent.content!.push(listNode)
          else topLevelPush(listNode)
        } else {
          // Same indent but different list kind, or no list open at all.
          closeListsTo(indent - 2)
          const enclosing = listStack[listStack.length - 1]
          if (enclosing && enclosing.indent < indent) {
            const items = enclosing.node.content!
            const parent = items[items.length - 1]
            if (parent) parent.content!.push(listNode)
            else topLevelPush(listNode)
          } else {
            closeAllLists()
            topLevelPush(listNode)
          }
        }
        listStack.push({ node: listNode, indent, ordered })
        top = listStack[listStack.length - 1]
      }
      top.node.content!.push({ type: 'listItem', content: [paragraph(item[3])] })
      continue
    }

    closeAllLists()
    topLevelPush(paragraph(line))
  }

  if (fence) {
    const text = fence.lines.join('\n')
    blocks.push({
      type: 'codeBlock',
      attrs: fence.lang ? { language: fence.lang } : {},
      content: text ? [{ type: 'text', text }] : []
    })
  }
  return blocks
}

/** Markdown → complete ProseMirror doc JSON, ready for meetings.notes_json. */
export function markdownToPmDoc(markdown: string): string {
  const blocks = markdownToBlocks(markdown)
  return JSON.stringify({
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }]
  })
}

/** Append markdown to an existing notes_json doc. Throws when the stored doc
 *  does not parse — the caller surfaces that rather than silently replacing
 *  the user's text. */
export function appendMarkdownToDoc(notesJson: string, markdown: string): string {
  let doc: PmNode
  try {
    doc = JSON.parse(notesJson || '{}') as PmNode
  } catch {
    throw new Error('This note\'s rough notes are not valid ProseMirror JSON; cannot append.')
  }
  if (typeof doc !== 'object' || doc === null || (doc.type !== undefined && doc.type !== 'doc')) {
    throw new Error('This note\'s rough notes are not a ProseMirror document; cannot append.')
  }
  const content = Array.isArray(doc.content) ? doc.content : []
  return JSON.stringify({ type: 'doc', content: [...content, ...markdownToBlocks(markdown)] })
}
