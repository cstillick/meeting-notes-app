import { create } from 'zustand'
import type { Folder, Meeting, MeetingSummary } from '@shared/types'

interface LibraryState {
  meetings: MeetingSummary[]
  folders: Folder[]
  /** Search box text; empty means the plain meetings list. */
  query: string
  /** null = "All notes"; a folder id scopes the list and the chat to that folder. */
  selectedFolderId: string | null
  /** False until the first meetings fetch lands, so the empty state can wait. */
  ready: boolean
  setQuery: (query: string) => void
  selectFolder: (folderId: string | null) => void
  refreshMeetings: () => Promise<void>
  refreshFolders: () => Promise<void>
  createFolder: (name: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  createMeeting: () => Promise<Meeting>
  moveToFolder: (meetingId: string, folderId: string | null) => Promise<void>
  deleteMeeting: (meetingId: string) => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  // The sidebar's per-folder counts are derived from `meetings`, so a mutation
  // to either list invalidates both. Refreshing both here is what keeps call
  // sites from having to work out which one they changed.
  const refreshAll = async (): Promise<void> => {
    await Promise.all([get().refreshMeetings(), get().refreshFolders()])
  }

  return {
    meetings: [],
    folders: [],
    query: '',
    selectedFolderId: null,
    ready: false,

    setQuery: (query) => set({ query }),
    selectFolder: (selectedFolderId) => set({ selectedFolderId }),

    refreshMeetings: async () => {
      const q = get().query.trim()
      const meetings = q
        ? await window.api.invoke('search:query', q)
        : await window.api.invoke('meetings:list')
      set({ meetings, ready: true })
    },

    refreshFolders: async () => {
      const folders = await window.api.invoke('folders:list')
      // The selected folder may have been deleted from under us.
      const selected = get().selectedFolderId
      const stillThere = selected !== null && folders.some((f) => f.id === selected)
      set({ folders, selectedFolderId: stillThere ? selected : null })
    },

    createFolder: async (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const folder = await window.api.invoke('folders:create', trimmed)
      await refreshAll()
      set({ selectedFolderId: folder.id })
    },

    renameFolder: async (folderId, name) => {
      const trimmed = name.trim()
      const current = get().folders.find((f) => f.id === folderId)
      if (!trimmed || !current || trimmed === current.name) return
      await window.api.invoke('folders:rename', folderId, trimmed)
      await refreshAll()
    },

    deleteFolder: async (folderId) => {
      await window.api.invoke('folders:delete', folderId)
      if (get().selectedFolderId === folderId) set({ selectedFolderId: null })
      await refreshAll()
    },

    createMeeting: async () => {
      const meeting = await window.api.invoke('meetings:create')
      const folderId = get().selectedFolderId
      if (folderId) await window.api.invoke('meetings:setFolder', meeting.id, folderId)
      await refreshAll()
      return meeting
    },

    moveToFolder: async (meetingId, folderId) => {
      await window.api.invoke('meetings:setFolder', meetingId, folderId)
      await refreshAll()
    },

    deleteMeeting: async (meetingId) => {
      await window.api.invoke('meetings:delete', meetingId)
      await refreshAll()
    }
  }
})
