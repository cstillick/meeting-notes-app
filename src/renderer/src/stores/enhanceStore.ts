import { create } from 'zustand'
import { enhancedMarkdownToDoc, splitTitle } from '../editor/markdownToDoc'

interface EnhanceState {
  /** meetingId currently streaming, if any */
  streamingId: string | null
  /** accumulated markdown for the streaming meeting */
  buffer: string
  error: string | null
  /** bumped when a result is saved so views can reload the meeting */
  savedVersion: number
  start: (meetingId: string) => Promise<string | null>
  cancel: () => void
}

let pendingThrottle: ReturnType<typeof setTimeout> | null = null
let pendingBuffer = ''
let listenersAttached = false

export const useEnhanceStore = create<EnhanceState>((set, get) => {
  if (!listenersAttached) {
    listenersAttached = true

    window.api.on('enhance:delta', ({ meetingId, text }) => {
      if (get().streamingId !== meetingId) return
      pendingBuffer += text
      // Throttle renders to ~10/sec; deltas can arrive much faster.
      if (!pendingThrottle) {
        pendingThrottle = setTimeout(() => {
          pendingThrottle = null
          set((s) => ({ buffer: s.buffer + pendingBuffer }))
          pendingBuffer = ''
        }, 100)
      }
    })

    window.api.on('enhance:done', ({ meetingId, markdown }) => {
      if (pendingThrottle) {
        clearTimeout(pendingThrottle)
        pendingThrottle = null
        pendingBuffer = ''
      }
      const { title, body } = splitTitle(markdown)
      let docJson: string
      try {
        docJson = JSON.stringify(enhancedMarkdownToDoc(body))
      } catch {
        // Keep the raw markdown even if conversion fails
        docJson = JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }]
        })
      }
      void window.api
        .invoke('enhance:saveResult', meetingId, docJson, markdown, title ?? undefined)
        .then(() => {
          set((s) => ({
            streamingId: null,
            buffer: '',
            savedVersion: s.savedVersion + 1
          }))
        })
    })

    window.api.on('enhance:error', ({ meetingId, message }) => {
      if (get().streamingId !== meetingId) return
      if (pendingThrottle) {
        clearTimeout(pendingThrottle)
        pendingThrottle = null
        pendingBuffer = ''
      }
      set({ streamingId: null, buffer: '', error: message })
    })
  }

  return {
    streamingId: null,
    buffer: '',
    error: null,
    savedVersion: 0,

    start: async (meetingId) => {
      set({ streamingId: meetingId, buffer: '', error: null })
      const result = await window.api.invoke('enhance:start', meetingId)
      if (!result.ok) {
        set({ streamingId: null })
        return result.error ?? 'Failed to start enhancement'
      }
      return null
    },

    cancel: () => {
      void window.api.invoke('enhance:cancel')
    }
  }
})
