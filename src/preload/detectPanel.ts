// Preload for the floating "meeting detected" panel. The panel is a two-button
// prompt drawn over the user's call: it gets its own bridge exposing the single
// channel it needs, never the app's, so a window with no app content cannot
// reach the notes and transcripts behind window.api.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('detect', {
  action(action: 'start' | 'dismiss'): void {
    void ipcRenderer.invoke('detect:action', action)
  }
})
