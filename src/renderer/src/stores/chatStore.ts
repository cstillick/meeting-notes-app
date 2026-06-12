import { create } from 'zustand'
import { chatKeyFor, type ChatMessage } from '@shared/types'
import { useActiveMeetingStore } from './activeMeetingStore'

export const chatKeyOf = chatKeyFor

export interface ChatThread {
  messages: ChatMessage[]
  /** accumulated markdown of the answer currently streaming */
  streamBuffer: string
  streaming: boolean
  error: string | null
  historyLoaded: boolean
  /** last question sent — lets the error row offer Retry */
  lastQuestion: string | null
}

const EMPTY_THREAD: ChatThread = {
  messages: [],
  streamBuffer: '',
  streaming: false,
  error: null,
  historyLoaded: false,
  lastQuestion: null
}

interface ChatState {
  threads: Record<string, ChatThread>
  /** chatKey of the expanded panel, if any (one open at a time) */
  openKey: string | null
  loadHistory: (meetingId: string | null, folderId?: string | null) => Promise<void>
  send: (meetingId: string | null, folderId: string | null, question: string) => Promise<void>
  cancel: (meetingId: string | null, folderId?: string | null) => void
  clear: (meetingId: string | null, folderId?: string | null) => Promise<void>
  setOpen: (key: string | null) => void
}

// Deltas can arrive much faster than React should render; buffer them per
// thread and flush ~10/sec (same pattern as enhanceStore, but keyed).
const pendingBuffers = new Map<string, string>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
let listenersAttached = false

// Optimistic user messages get temporary ids well clear of SQLite rowids.
let tempId = -1

export const useChatStore = create<ChatState>((set, get) => {
  const patchThread = (chatKey: string, patch: Partial<ChatThread>): void => {
    set((s) => ({
      threads: {
        ...s.threads,
        [chatKey]: { ...(s.threads[chatKey] ?? EMPTY_THREAD), ...patch }
      }
    }))
  }

  const flushPending = (chatKey: string): void => {
    const timer = pendingTimers.get(chatKey)
    if (timer) {
      clearTimeout(timer)
      pendingTimers.delete(chatKey)
    }
    const pending = pendingBuffers.get(chatKey)
    if (pending) {
      pendingBuffers.delete(chatKey)
      const thread = get().threads[chatKey] ?? EMPTY_THREAD
      patchThread(chatKey, { streamBuffer: thread.streamBuffer + pending })
    }
  }

  if (!listenersAttached) {
    listenersAttached = true

    window.api.on('chat:delta', ({ chatKey, text }) => {
      pendingBuffers.set(chatKey, (pendingBuffers.get(chatKey) ?? '') + text)
      if (!pendingTimers.has(chatKey)) {
        pendingTimers.set(
          chatKey,
          setTimeout(() => {
            pendingTimers.delete(chatKey)
            const pending = pendingBuffers.get(chatKey) ?? ''
            pendingBuffers.delete(chatKey)
            const thread = get().threads[chatKey] ?? EMPTY_THREAD
            patchThread(chatKey, { streamBuffer: thread.streamBuffer + pending })
          }, 100)
        )
      }
    })

    window.api.on('chat:done', ({ chatKey, message }) => {
      flushPending(chatKey)
      pendingBuffers.delete(chatKey)
      const thread = get().threads[chatKey] ?? EMPTY_THREAD
      patchThread(chatKey, {
        messages: [...thread.messages, message],
        streamBuffer: '',
        streaming: false,
        error: null
      })
    })

    window.api.on('chat:error', ({ chatKey, message }) => {
      flushPending(chatKey)
      pendingBuffers.delete(chatKey)
      patchThread(chatKey, { streamBuffer: '', streaming: false, error: message })
    })
  }

  return {
    threads: {},
    openKey: null,

    loadHistory: async (meetingId, folderId = null) => {
      const chatKey = chatKeyOf(meetingId, folderId)
      if (get().threads[chatKey]?.historyLoaded) return
      const messages = await window.api.invoke('chat:history', meetingId, folderId)
      const thread = get().threads[chatKey] ?? EMPTY_THREAD
      // A stream may have started while history was in flight — keep its state.
      patchThread(chatKey, { ...thread, messages, historyLoaded: true })
    },

    send: async (meetingId, folderId, question) => {
      const chatKey = chatKeyOf(meetingId, folderId)
      const q = question.trim()
      if (!q) return
      const thread = get().threads[chatKey] ?? EMPTY_THREAD
      if (thread.streaming) return

      const optimistic: ChatMessage = {
        id: tempId--,
        meetingId,
        role: 'user',
        content: q,
        createdAt: Date.now()
      }
      patchThread(chatKey, {
        messages: [...thread.messages, optimistic],
        streamBuffer: '',
        streaming: true,
        error: null,
        lastQuestion: q
      })

      // Mid-recording, the renderer's finals are fresher than the DB (mic
      // finals are held ~3.5s for echo checks) — pass them along.
      const { recordingMeetingId, finals } = useActiveMeetingStore.getState()
      const liveFinals =
        meetingId !== null && recordingMeetingId === meetingId ? finals : undefined

      const result = await window.api.invoke('chat:send', {
        meetingId,
        folderId,
        question: q,
        liveFinals
      })
      if (!result.ok) {
        const t = get().threads[chatKey] ?? EMPTY_THREAD
        patchThread(chatKey, {
          messages: t.messages.filter((m) => m.id !== optimistic.id),
          streaming: false,
          error: result.error ?? 'Failed to send'
        })
      }
    },

    cancel: (meetingId, folderId = null) => {
      void window.api.invoke('chat:cancel', chatKeyOf(meetingId, folderId))
    },

    clear: async (meetingId, folderId = null) => {
      await window.api.invoke('chat:clear', meetingId, folderId)
      patchThread(chatKeyOf(meetingId, folderId), { ...EMPTY_THREAD, historyLoaded: true })
    },

    setOpen: (key) => set({ openKey: key })
  }
})
