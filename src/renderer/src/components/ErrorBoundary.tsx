import React from 'react'

const BUTTON_CLASS = 'rounded-md px-3 py-1.5 text-sm font-medium shadow-sm'

/** Last-resort guard. Without it a throw anywhere in the tree leaves a blank
 *  window while the recorder keeps running in main — audiotee still holding the
 *  Core Audio tap, mic indicator still lit, and no Stop button anywhere. This
 *  panel deliberately depends on nothing but window.api. */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; stopped: boolean; stopError: string | null }
> {
  state = { error: null as Error | null, stopped: false, stopError: null as string | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] render error', error, info.componentStack)
    try {
      window.api.send(
        'log:error',
        `render error: ${error.stack ?? error.message}${info.componentStack ?? ''}`.slice(0, 4000)
      )
    } catch {
      // the log line is best-effort; the panel below is the real fallback
    }
  }

  private stopRecording(): void {
    window.api
      .invoke('recorder:stop')
      .then(() => this.setState({ stopped: true, stopError: null }))
      .catch((e) => this.setState({ stopError: e instanceof Error ? e.message : String(e) }))
  }

  render(): React.ReactNode {
    const { error, stopped, stopError } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-8">
        <h1 className="text-lg font-semibold text-stone-700">Something broke in the interface</h1>
        <p className="max-w-lg text-center text-sm text-stone-500">
          Your notes and transcript are already saved. A recording, if one was running, is still
          going in the background — stop it here, then reload.
        </p>
        <pre className="max-h-40 w-full max-w-lg overflow-auto rounded-md bg-stone-100 p-3 text-xs whitespace-pre-wrap text-stone-600">
          {error.stack || String(error)}
        </pre>
        <div className="flex items-center gap-2">
          <button
            onClick={() => this.stopRecording()}
            disabled={stopped}
            className={`${BUTTON_CLASS} bg-red-600 text-white hover:bg-red-700 disabled:opacity-40`}
          >
            {stopped ? 'Recording stopped' : 'Stop recording'}
          </button>
          <button
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
            className={`${BUTTON_CLASS} bg-stone-200 text-stone-700 hover:bg-stone-300`}
          >
            Reload
          </button>
        </div>
        {stopError && (
          <p className="text-sm text-red-600">
            Couldn’t stop the recording: {stopError} — quit the app to release the microphone.
          </p>
        )}
      </div>
    )
  }
}
