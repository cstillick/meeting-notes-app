// PDF export: render the standalone HTML in a hidden window and print it.
// Chromium's print pipeline does the typesetting, so the PDF matches the HTML
// export exactly. Loaded from a temp file, not a data: URL — a two-hour
// transcript exceeds what a URL can carry.
import { randomUUID } from 'crypto'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow, app } from 'electron'

export async function htmlToPdf(html: string): Promise<Buffer> {
  const tempPath = join(app.getPath('temp'), `granola-export-${randomUUID()}.html`)
  writeFileSync(tempPath, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
      // No preload: the document is our own generated HTML with all note text
      // escaped, and it gets no bridge and no privileges anyway.
    }
  })
  try {
    await win.loadFile(tempPath)
    return await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      pageSize: 'Letter'
    })
  } finally {
    win.destroy()
    try {
      unlinkSync(tempPath)
    } catch {
      // temp cleanup is best-effort
    }
  }
}
