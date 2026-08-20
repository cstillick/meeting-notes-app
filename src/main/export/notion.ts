// Direct Notion export over the public REST API — the user's own internal
// integration token (Settings), no SDK. Markdown converts through the same
// block model every other exporter uses.
//
// API constraints honoured here: 100 children per request (the rest appended
// in batches), 2000 chars per rich_text element, one level of child nesting
// per request (deeper lists flatten), and ~3 requests/second (serialized with
// a delay).
import { markdownToBlocks, type PmNode } from '../../mcp/pm'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const BATCH = 100
const REQUEST_GAP_MS = 350
const MAX_RICH_TEXT = 2000

interface RichText {
  type: 'text'
  text: { content: string; link?: { url: string } | null }
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean }
}

export interface NotionBlock {
  object: 'block'
  type: string
  [key: string]: unknown
}

function richText(
  content: string,
  annotations: { bold?: boolean; italic?: boolean; code?: boolean } = {},
  url?: string
): RichText[] {
  const parts: RichText[] = []
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT) {
    const chunk = content.slice(i, i + MAX_RICH_TEXT)
    const rt: RichText = { type: 'text', text: { content: chunk } }
    if (url) rt.text.link = { url }
    if (annotations.bold || annotations.italic || annotations.code) rt.annotations = annotations
    parts.push(rt)
  }
  return parts
}

function inlineRich(nodes: PmNode[] | undefined): RichText[] {
  if (!nodes) return []
  const out: RichText[] = []
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push(...richText('\n'))
      continue
    }
    if (typeof n.text !== 'string') {
      out.push(...inlineRich(n.content))
      continue
    }
    const ann: { bold?: boolean; italic?: boolean; code?: boolean } = {}
    let url: string | undefined
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') ann.bold = true
      if (m.type === 'italic') ann.italic = true
      if (m.type === 'code') ann.code = true
      if (m.type === 'link') url = String(m.attrs?.href ?? '')
    }
    out.push(...richText(n.text, ann, url))
  }
  return out.length > 0 ? out : richText('')
}

function listItems(node: PmNode, ordered: boolean, depth: number): NotionBlock[] {
  const type = ordered ? 'numbered_list_item' : 'bulleted_list_item'
  const blocks: NotionBlock[] = []
  for (const item of node.content ?? []) {
    let text: RichText[] = richText('')
    const children: NotionBlock[] = []
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        const nested = listItems(child, child.type === 'orderedList', depth + 1)
        // One level of nesting per request; deeper levels flatten upward.
        if (depth === 0) children.push(...nested)
        else blocks.push(...nested)
      } else if (child.type === 'paragraph' || child.type === 'heading') {
        text = inlineRich(child.content)
      }
    }
    const block: NotionBlock = { object: 'block', type, [type]: { rich_text: text } }
    if (children.length > 0) {
      ;(block[type] as { children?: NotionBlock[] }).children = children.slice(0, BATCH)
    }
    blocks.push(block)
  }
  return blocks
}

export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = []
  for (const node of markdownToBlocks(markdown)) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)))
        const type = `heading_${level}`
        blocks.push({ object: 'block', type, [type]: { rich_text: inlineRich(node.content) } })
        break
      }
      case 'paragraph':
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: inlineRich(node.content) }
        })
        break
      case 'bulletList':
      case 'orderedList':
        blocks.push(...listItems(node, node.type === 'orderedList', 0))
        break
      case 'blockquote': {
        const text = (node.content ?? []).flatMap((c) => inlineRich(c.content))
        blocks.push({ object: 'block', type: 'quote', quote: { rich_text: text } })
        break
      }
      case 'codeBlock': {
        const text = (node.content ?? []).map((c) => c.text ?? '').join('')
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            rich_text: richText(text.slice(0, MAX_RICH_TEXT * 10)),
            language: typeof node.attrs?.language === 'string' && node.attrs.language ? node.attrs.language : 'plain text'
          }
        })
        break
      }
      case 'horizontalRule':
        blocks.push({ object: 'block', type: 'divider', divider: {} })
        break
      default:
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: inlineRich(node.content) }
        })
    }
  }
  return blocks
}

/** Accept a raw id, a dashed id, or a full Notion URL. */
export function normalizePageId(ref: string): string {
  const match = ref.match(
    /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  )
  if (!match) return ref
  const raw = match[0].replace(/-/g, '')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function notionRequest(
  token: string,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400)
    if (response.status === 401) {
      throw new Error('Notion rejected the token (401). Re-check the integration token in Settings.')
    }
    if (response.status === 404) {
      throw new Error(
        'Notion returned 404 for the parent page — the page id is wrong, or the page is not shared with your integration (open the page in Notion → ⋯ → Connections → add your integration).'
      )
    }
    throw new Error(`Notion API error ${response.status}: ${detail}`)
  }
  await sleep(REQUEST_GAP_MS)
  return (await response.json()) as Record<string, unknown>
}

export interface NotionPageResult {
  id: string
  url: string
}

/** Create a page under a parent page and fill it, batching children. */
export async function createNotionPage(args: {
  token: string
  parentPageId: string
  title: string
  blocks: NotionBlock[]
}): Promise<NotionPageResult> {
  const first = args.blocks.slice(0, BATCH)
  const page = await notionRequest(args.token, 'POST', '/pages', {
    parent: { page_id: args.parentPageId },
    properties: {
      title: { title: richText(args.title.slice(0, 200)) }
    },
    children: first
  })
  const id = String(page.id)
  const url = typeof page.url === 'string' ? page.url : ''
  for (let i = BATCH; i < args.blocks.length; i += BATCH) {
    await notionRequest(args.token, 'PATCH', `/blocks/${id}/children`, {
      children: args.blocks.slice(i, i + BATCH)
    })
  }
  return { id, url }
}
