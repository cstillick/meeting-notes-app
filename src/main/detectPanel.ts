// Floating "meeting detected" panel: a tiny always-on-top window drawn by us,
// because system notifications are unreliable for ad-hoc-signed apps (macOS
// silently drops them — Notification Center never registers the app). Shown
// in the top-right corner, over fullscreen meeting apps, without stealing
// focus. Buttons talk back over a panel-only bridge ('detect:action').
import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

const PANEL_HTML = join(__dirname, '../preload/detectPanel.html')

/** The panel's document URL, so navigation and IPC-sender checks recognise it
 *  as one of the app's own. */
export function getDetectPanelUrl(): string {
  return pathToFileURL(PANEL_HTML).href
}

let panel: BrowserWindow | null = null

export function showDetectPanel(): void {
  if (panel) return
  const { workArea } = screen.getPrimaryDisplay()
  const width = 380
  const height = 52
  panel = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/detectPanel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // Float above fullscreen meeting windows on every space.
  panel.setAlwaysOnTop(true, 'screen-saver')
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panel.on('closed', () => {
    panel = null
  })
  void panel.loadFile(PANEL_HTML)
  // showInactive: never steal focus from the meeting the user just joined.
  panel.once('ready-to-show', () => panel?.showInactive())
}

export function closeDetectPanel(): void {
  const p = panel
  panel = null
  if (p && !p.isDestroyed()) p.close()
}
