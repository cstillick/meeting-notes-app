import { Route, Routes } from 'react-router-dom'
import HomeView from './components/home/HomeView'
import NoteView from './components/note/NoteView'
import SettingsView from './components/settings/SettingsView'
import GraphView from './components/graph/GraphView'
import MeetingDetectedBanner from './components/MeetingDetectedBanner'

export default function App(): React.JSX.Element {
  return (
    <>
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/note/:id" element={<NoteView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/graph" element={<GraphView />} />
      </Routes>
      <MeetingDetectedBanner />
    </>
  )
}
