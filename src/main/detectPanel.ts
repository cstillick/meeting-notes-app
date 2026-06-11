// Floating "meeting detected" panel: a tiny always-on-top window drawn by us,
// because system notifications are unreliable for ad-hoc-signed apps (macOS
// silently drops them — Notification Center never registers the app). Shown
// in the top-right corner, over fullscreen meeting apps, without stealing
// focus. Buttons talk back over the regular preload bridge ('detect:action').
import { BrowserWindow, screen } from 'electron'
import { join } from 'path'

const PANEL_HTML = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:transparent;font:13px -apple-system,sans-serif;-webkit-user-select:none;overflow:hidden}
  .wrap{display:flex;align-items:center;gap:10px;height:100vh;padding:0 8px 0 14px;background:#fff;
    border:1px solid #e7e5e4;border-radius:12px;box-sizing:border-box}
  .msg{color:#44403c;flex:1;white-space:nowrap}
  button{font:inherit;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;background:transparent}
  .start{background:#d97706;color:#fff;font-weight:600}
  .start:hover{background:#b45309}
  .dismiss{color:#a8a29e;padding:6px 8px}
  .dismiss:hover{color:#57534e}
</style>
<div class="wrap">
  <span class="msg">Meeting detected &mdash; take notes?</span>
  <button class="start" onclick="window.api.invoke('detect:action','start')">Start recording</button>
  <button class="dismiss" onclick="window.api.invoke('detect:action','dismiss')" title="Dismiss">&#10005;</button>
</div>`

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
      preload: join(__dirname, '../preload/index.js'),
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
  void panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PANEL_HTML))
  // showInactive: never steal focus from the meeting the user just joined.
  panel.once('ready-to-show', () => panel?.showInactive())
}

export function closeDetectPanel(): void {
  const p = panel
  panel = null
  if (p && !p.isDestroyed()) p.close()
}
