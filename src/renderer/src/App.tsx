import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import HomeView from './components/home/HomeView'
import NoteView from './components/note/NoteView'
import SettingsView from './components/settings/SettingsView'
import MeetingDetectedBanner from './components/MeetingDetectedBanner'
import { useSettingsStore } from './stores/settingsStore'
import { applyTheme } from './theme'

export default function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.settings?.theme)
  const load = useSettingsStore((s) => s.load)

  // Load settings once so the saved appearance applies app-wide, on any route.
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])

  return (
    <>
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/note/:id" element={<NoteView />} />
        <Route path="/settings" element={<SettingsView />} />
      </Routes>
      <MeetingDetectedBanner />
    </>
  )
}
