import { create } from 'zustand'
import type { SettingsUpdate, SettingsView } from '@shared/types'

interface SettingsState {
  settings: SettingsView | null
  load: () => Promise<void>
  save: (update: SettingsUpdate) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  load: async () => {
    set({ settings: await window.api.invoke('settings:get') })
  },
  save: async (update) => {
    set({ settings: await window.api.invoke('settings:set', update) })
  }
}))
