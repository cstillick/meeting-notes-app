import { create } from 'zustand'
import { chatKeyFor, type ChatMessage } from '@shared/types'
import { useActiveMeetingStore } from './activeMeetingStore'

export const chatKeyOf = chatKeyFor

/** Inverse of chatKeyOf — chat:history and chat:clear still take the
 *  (meetingId, folderId) pair the key was built from. */
function chatKeyParts(chatKey: string): { meetingId: string | null; folderId: string | null } {
  if (chatKey === 'global') return { meetingId: null, folderId: null }
  if (chatKey.startsWith('folder:')) {
    return { meetingId: null, folderId: chatKey.slice('folder:'.length) }
  }
  return { meetingId: chatKey, folderId: null }
}

export interface ChatThread {
  messages: ChatMessage[]
  /** accumulated markdown of the answer currently streaming */
  streamBuffer: string
  streaming: boolean
  error: string | null
  /** transport-level failure (429/5xx) — a retry is likely to succeed */
  errorRetryable: boolean
  historyLoaded: boolean
  /** last question sent — lets the error row offer Retry */
  lastQuestion: string | null
}

const EMPTY_THREAD: ChatThread = {
  messages: [],
  streamBuffer: '',
  streaming: false,
  error: null,
  errorRetryable: false,
  historyLoaded: false,
  lastQuestion: null
}

interface ChatState {
  threads: Record<string, ChatThread>
  /** chatKey of the expanded panel, if any (one open at a time) */
  openKey: string | null
  // Keyed by chatKey rather than a (meetingId, folderId) pair: a caller that
  // forgot the second argument silently addressed the global thread.
  loadHistory: (chatKey: string) => Promise<void>
  send: (meetingId: string | null, folderId: string | null, question: string) => Promise<void>
  cancel: (chatKey: string) => void
  clear: (chatKey: string) => Promise<void>
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

    window.api.on('chat:error', ({ chatKey, message, retryable }) => {
      flushPending(chatKey)
      pendingBuffers.delete(chatKey)
      patchThread(chatKey, {
        streamBuffer: '',
        streaming: false,
        error: message,
        errorRetryable: retryable
      })
    })
  }

  return {
    threads: {},
    openKey: null,

    loadHistory: async (chatKey) => {
      if (get().threads[chatKey]?.historyLoaded) return
      const { meetingId, folderId } = chatKeyParts(chatKey)
      let messages: ChatMessage[]
      try {
        messages = await window.api.invoke('chat:history', meetingId, folderId)
      } catch (e) {
        patchThread(chatKey, {
          error: `Couldn't load this conversation: ${e instanceof Error ? e.message : String(e)}`,
          errorRetryable: false
        })
        return
      }
      // A stream may have started while history was in flight — patchThread
      // merges onto the current thread, so its state survives.
      patchThread(chatKey, { messages, historyLoaded: true })
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

      // A rejected invoke here would strand the thread streaming forever, with
      // the dock stuck on Stop and no message — treat it as a failed send.
      let result: { ok: boolean; error?: string }
      try {
        result = await window.api.invoke('chat:send', {
          meetingId,
          folderId,
          question: q,
          liveFinals
        })
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      if (!result.ok) {
        const t = get().threads[chatKey] ?? EMPTY_THREAD
        patchThread(chatKey, {
          messages: t.messages.filter((m) => m.id !== optimistic.id),
          streaming: false,
          error: result.error ?? 'Failed to send',
          errorRetryable: false
        })
      }
    },

    cancel: (chatKey) => {
      window.api.invoke('chat:cancel', chatKey).catch((e) => {
        console.error('[chat] cancel failed', e)
      })
    },

    clear: async (chatKey) => {
      const { meetingId, folderId } = chatKeyParts(chatKey)
      try {
        await window.api.invoke('chat:clear', meetingId, folderId)
      } catch (e) {
        patchThread(chatKey, {
          error: `Couldn't clear this conversation: ${e instanceof Error ? e.message : String(e)}`,
          errorRetryable: false
        })
        return
      }
      patchThread(chatKey, { ...EMPTY_THREAD, historyLoaded: true })
    },

    setOpen: (key) => set({ openKey: key })
  }
})
