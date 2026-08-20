import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { flushRenderers, registerIpc, stopMicMonitor } from './ipc'
import { getDetectPanelUrl } from './detectPanel'
import { recorder } from './transcription/recorder'
import { appLog } from './transcription/debugLog'
import { closeDb } from './db/database'
import { startControlServer, stopControlServer } from './control'
import { startCalendarWatcher, stopCalendarWatcher } from './calendar'

let mainWindow: BrowserWindow | null = null

/** Hand a URL to the OS only when it is a web link. openExternal launches
 *  whatever handler the scheme is registered to, so file:, smb: and custom
 *  schemes are execution vectors — and every link we see here came out of a
 *  model, from meeting audio we do not control. */
export function openExternalSafe(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    console.warn('nav: refused to open unparseable url')
    return
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    console.warn('nav: refused to open scheme', protocol)
    return
  }
  void shell.openExternal(url)
}

/** True for the documents the app itself loads. Anything else navigating a
 *  window would inherit the preload bridge and could read every note. */
export function isAppDocument(url: string): boolean {
  try {
    const target = new URL(url)
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && target.origin === new URL(devUrl).origin) return true
    return target.protocol === 'file:' && appDocumentPaths().includes(target.pathname)
  } catch {
    return false
  }
}

/** Percent-encoded, as the frame URLs we compare against are. */
function appDocumentPaths(): string[] {
  return [
    pathToFileURL(join(__dirname, '../renderer/index.html')).pathname,
    new URL(getDetectPanelUrl()).pathname
  ]
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** Bring the app forward, recreating the window if it was closed. Resolves
 * once the renderer is loaded, so events sent to it afterwards are received. */
export async function showMainWindow(): Promise<BrowserWindow> {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }
  createWindow()
  const win = mainWindow!
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  return win
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Chat answers and enhanced notes are model output rendered as HTML, so their
// anchors are untrusted: a top-level navigation keeps webPreferences.preload,
// which would hand window.api to whatever loaded. Registered app-wide so the
// detect panel's webContents is covered too.
app.on('web-contents-created', (_event, contents) => {
  const guard = (event: Electron.Event, url: string): void => {
    if (isAppDocument(url)) return
    event.preventDefault()
    openExternalSafe(url)
  }
  // will-redirect as well: will-navigate only sees the request, so a redirect
  // away from a URL we allowed would otherwise land unchecked.
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
})

// One instance only. A second copy's startup recovery would flip a live
// recording's status to 'recorded' with a bogus ended_at (getDb runs
// recoverTransientStatuses in every process), and two writers on one file
// surface as SQLITE_BUSY throws in whichever loses the 3 s busy_timeout.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  void showMainWindow()
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  console.log(`Granola Clone build: ${__BUILD_INFO__.commit} @ ${__BUILD_INFO__.time}`)
  registerIpc()
  startControlServer()
  startCalendarWatcher()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never orphan the audio helpers: a stale tap leaves the orange mic indicator on.
// recorder.stop() flushes trailing transcript finals to the DB, so quitting must
// wait for it before closing the DB and exiting. The renderer flush comes first:
// app.exit never fires pagehide, so its debounced editor saves would be lost.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    await flushRenderers(800)
    try {
      await recorder.stop()
    } catch (err) {
      console.error('quit: recorder.stop failed', err)
    }
    stopMicMonitor()
    stopCalendarWatcher()
    stopControlServer()
    closeDb()
    app.exit(0)
  })()
})

// A main-process fault must still tear down capture: the audiotee child and its
// Core Audio tap survive our crash, leaving the recording indicator lit with no
// app behind it. Bounded — the fault may have broken the machinery stop() awaits.
let crashing = false
function crashExit(kind: string, reason: unknown): void {
  if (crashing) return
  crashing = true
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  appLog('crash', `${kind}: ${detail}`)
  console.error(`crash: ${kind}`, reason)
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  void Promise.race([recorder.stop().catch(() => {}), deadline]).then(() => {
    try {
      stopMicMonitor()
    } catch {
      // already down
    }
    try {
      stopControlServer()
    } catch {
      // best-effort; a stale socket is reclaimed on next launch
    }
    try {
      closeDb()
    } catch {
      // a torn DB is the crash reporter's problem, not the exit path's
    }
    app.exit(1)
  })
}

process.on('uncaughtException', (err) => crashExit('uncaughtException', err))
process.on('unhandledRejection', (reason) => crashExit('unhandledRejection', reason))
