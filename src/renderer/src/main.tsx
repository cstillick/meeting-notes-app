import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { applyTheme, getStoredTheme } from './theme'
import './assets/main.css'

// Apply the cached appearance before the first paint to avoid a light-mode flash.
// The authoritative value from settings.json is applied later by App once loaded.
applyTheme(getStoredTheme())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
