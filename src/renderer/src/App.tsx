import { Route, Routes } from 'react-router-dom'
import HomeView from './components/home/HomeView'
import NoteView from './components/note/NoteView'
import SettingsView from './components/settings/SettingsView'

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<HomeView />} />
      <Route path="/note/:id" element={<NoteView />} />
      <Route path="/settings" element={<SettingsView />} />
    </Routes>
  )
}
