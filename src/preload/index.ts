import { contextBridge, ipcRenderer } from 'electron'
import type { EventMap, InvokeMap, SendMap } from '../shared/ipc'

const api = {
  invoke<K extends keyof InvokeMap>(
    channel: K,
    ...args: Parameters<InvokeMap[K]>
  ): Promise<ReturnType<InvokeMap[K]>> {
    return ipcRenderer.invoke(channel, ...args)
  },

  send<K extends keyof SendMap>(channel: K, ...args: Parameters<SendMap[K]>): void {
    ipcRenderer.send(channel, ...args)
  },

  on<K extends keyof EventMap>(
    channel: K,
    listener: (...args: Parameters<EventMap[K]>) => void
  ): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      listener(...(args as Parameters<EventMap[K]>))
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
