import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc, stopMicMonitor } from './ipc'
import { recorder } from './transcription/recorder'
import { closeDb } from './db/database'

let mainWindow: BrowserWindow | null = null

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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  console.log(`Granola Clone build: ${__BUILD_INFO__.commit} @ ${__BUILD_INFO__.time}`)
  registerIpc()
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
// wait for it before closing the DB and exiting.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    try {
      await recorder.stop()
    } catch (err) {
      console.error('quit: recorder.stop failed', err)
    }
    stopMicMonitor()
    closeDb()
    app.exit(0)
  })()
})
