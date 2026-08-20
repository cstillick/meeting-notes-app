// Minimal .docx writer, dependency-free.
//
// A .docx is a zip of XML parts; Word accepts STORE-method entries, so the
// container here is a hand-rolled zip (local headers + central directory +
// CRC-32) and the document is built from the same block model the MCP
// markdown parser produces — headings, paragraphs, nested lists, quotes,
// code. Good enough for notes; not a general OOXML library.
import { markdownToBlocks, type PmNode } from '../../mcp/pm'

// ---------------------------------------------------------------------------
// Zip container (store only)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** Store-only zip: no compression, maximum compatibility. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date (1980-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, entry.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(entry.data.length, 20)
    cd.writeUInt32LE(entry.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += 30 + name.length + entry.data.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

// ---------------------------------------------------------------------------
// OOXML document
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control chars are invalid in XML 1.0 and Word refuses the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

interface RunStyle {
  bold?: boolean
  italic?: boolean
  code?: boolean
}

function run(text: string, style: RunStyle): string {
  const props: string[] = []
  if (style.bold) props.push('<w:b/>')
  if (style.italic) props.push('<w:i/>')
  if (style.code) props.push('<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:sz w:val="19"/>')
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
}

/** Inline PM nodes → OOXML runs. Links render as their text plus the URL. */
function inlineRuns(nodes: PmNode[] | undefined, inherited: RunStyle = {}): string {
  if (!nodes) return ''
  let out = ''
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '<w:r><w:br/></w:r>'
      continue
    }
    if (typeof n.text !== 'string') {
      out += inlineRuns(n.content, inherited)
      continue
    }
    const style: RunStyle = { ...inherited }
    let href: string | null = null
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') style.bold = true
      if (m.type === 'italic') style.italic = true
      if (m.type === 'code') style.code = true
      if (m.type === 'link') href = String(m.attrs?.href ?? '')
    }
    out += run(n.text, style)
    if (href && href !== n.text) out += run(` (${href})`, { italic: true })
  }
  return out
}

function paragraph(content: string, props = ''): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`
}

function blockToXml(node: PmNode, listLevel = -1, ordered = false): string {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)))
      return paragraph(inlineRuns(node.content), `<w:pStyle w:val="Heading${level}"/>`)
    }
    case 'paragraph': {
      if (listLevel >= 0) {
        const numId = ordered ? 2 : 1
        return paragraph(
          inlineRuns(node.content),
          `<w:numPr><w:ilvl w:val="${Math.min(8, listLevel)}"/><w:numId w:val="${numId}"/></w:numPr>`
        )
      }
      return paragraph(inlineRuns(node.content))
    }
    case 'bulletList':
    case 'orderedList': {
      const isOrdered = node.type === 'orderedList'
      let out = ''
      for (const item of node.content ?? []) {
        for (const child of item.content ?? []) {
          if (child.type === 'bulletList' || child.type === 'orderedList') {
            out += blockToXmlNested(child, listLevel + 1)
          } else {
            out += blockToXml(child, listLevel + 1, isOrdered)
          }
        }
      }
      return out
    }
    case 'blockquote': {
      let out = ''
      for (const child of node.content ?? []) {
        out += paragraph(
          inlineRuns(child.content, { italic: true }),
          '<w:ind w:left="480"/>'
        )
      }
      return out
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('')
      return text
        .split('\n')
        .map((line) => paragraph(run(line, { code: true }), '<w:ind w:left="240"/>'))
        .join('')
    }
    case 'horizontalRule':
      return paragraph('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D6D3D1"/></w:pBdr>')
    default:
      return paragraph(inlineRuns(node.content))
  }
}

function blockToXmlNested(node: PmNode, level: number): string {
  const isOrdered = node.type === 'orderedList'
  let out = ''
  for (const item of node.content ?? []) {
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        out += blockToXmlNested(child, level + 1)
      } else {
        out += blockToXml(child, level, isOrdered)
      }
    }
  }
  return out
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="1">
${[0, 1, 2, 3].map((l) => `<w:lvl w:ilvl="${l}"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="${480 + l * 360}" w:hanging="240"/></w:pPr></w:lvl>`).join('\n')}
</w:abstractNum>
<w:abstractNum w:abstractNumId="2">
${[0, 1, 2, 3].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${l + 1}."/><w:pPr><w:ind w:left="${480 + l * 360}" w:hanging="300"/></w:pPr></w:lvl>`).join('\n')}
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`

/** Markdown → .docx file contents. */
export function markdownToDocx(markdown: string): Buffer {
  const blocks = markdownToBlocks(markdown)
  const body = blocks.map((b) => blockToXml(b)).join('')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(NUMBERING, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') }
  ])
}
