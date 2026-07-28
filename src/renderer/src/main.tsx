import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { attachQuitFlush } from './flush'
import './assets/main.css'

// Faults outside React's render path (event handlers, `void`-ed invokes) never
// reach the ErrorBoundary. Persist them to the main-process diagnostic log —
// a white screen mid-recording otherwise leaves no trace. Capped so a fault
// loop cannot flood the log; reporting must never become its own fault.
let reportBudget = 20
function reportFault(kind: string, reason: unknown): void {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  console.error(`[renderer] ${kind}`, reason)
  if (reportBudget-- <= 0) return
  try {
    window.api.send('log:error', `${kind}: ${detail}`)
  } catch {
    // bridge unavailable (tests, teardown)
  }
}
window.addEventListener('error', (e) => reportFault('uncaught', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => reportFault('unhandled rejection', e.reason))

attachQuitFlush()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
)
