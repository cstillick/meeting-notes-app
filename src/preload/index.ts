import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from '../shared/ipc'
import type { EventMap, InvokeMap, SendMap } from '../shared/ipc'

// The maps are types, erased at build time: without a runtime check the bridge
// forwards any channel name it is handed, including handlers no renderer is
// supposed to reach. Main double-checks the sender frame; this keeps the
// surface reachable from our own page down to the declared contract.
const invokable = new Set<string>(INVOKE_CHANNELS)
// Dev-only diagnostic, registered in main under the same condition and called
// from the DevTools console.
if (process.env['ELECTRON_RENDERER_URL']) invokable.add('debug:checkKeys')
const sendable = new Set<string>(SEND_CHANNELS)
const listenable = new Set<string>(EVENT_CHANNELS)

function assertAllowed(allowed: ReadonlySet<string>, channel: string): void {
  if (!allowed.has(channel)) throw new Error(`ipc: channel not allowed: ${channel}`)
}

const api = {
  invoke<K extends keyof InvokeMap>(
    channel: K,
    ...args: Parameters<InvokeMap[K]>
  ): Promise<ReturnType<InvokeMap[K]>> {
    assertAllowed(invokable, channel)
    return ipcRenderer.invoke(channel, ...args)
  },

  send<K extends keyof SendMap>(channel: K, ...args: Parameters<SendMap[K]>): void {
    assertAllowed(sendable, channel)
    ipcRenderer.send(channel, ...args)
  },

  on<K extends keyof EventMap>(
    channel: K,
    listener: (...args: Parameters<EventMap[K]>) => void
  ): () => void {
    assertAllowed(listenable, channel)
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      listener(...(args as Parameters<EventMap[K]>))
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
