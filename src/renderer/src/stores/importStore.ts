import { create } from 'zustand'
import type { ImportStatus } from '@shared/types'

interface ImportState {
  /** Live transcription jobs and sticky errors, keyed by note id. 'done'
   *  clears the entry — the refreshed note speaks for itself. */
  statuses: Record<string, ImportStatus>
  /** Picker-level failures (bad format, missing key), shown once on Home. */
  pickErrors: string[]
  startPick: () => Promise<void>
  dismissError: (noteId: string) => void
  clearPickErrors: () => void
}

let listenerAttached = false

export const useImportStore = create<ImportState>((set) => {
  if (!listenerAttached) {
    listenerAttached = true
    window.api.on('import:status', (status) => {
      set((s) => {
        const statuses = { ...s.statuses }
        if (status.state === 'done') delete statuses[status.meetingId]
        else statuses[status.meetingId] = status
        return { statuses }
      })
    })
  }

  return {
    statuses: {},
    pickErrors: [],

    startPick: async () => {
      const result = await window.api.invoke('import:pick')
      if (!result) return
      set({ pickErrors: result.errors })
    },

    dismissError: (noteId) =>
      set((s) => {
        const statuses = { ...s.statuses }
        delete statuses[noteId]
        return { statuses }
      }),

    clearPickErrors: () => set({ pickErrors: [] })
  }
})
