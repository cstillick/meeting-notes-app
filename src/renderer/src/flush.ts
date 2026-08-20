// Debounced editors (notes, title, enhanced doc) register their flush here so
// quit can drain them. pagehide alone is not enough: main quits via app.exit,
// which tears the window down without firing it. Main sends app:will-quit,
// waits (bounded) for the app:flushed ack, and only then closes the DB.

type Flusher = () => void | Promise<unknown>

const flushers = new Set<Flusher>()

export function registerFlush(fn: Flusher): () => void {
  flushers.add(fn)
  return () => flushers.delete(fn)
}

export function attachQuitFlush(): void {
  window.api.on('app:will-quit', () => {
    void Promise.allSettled([...flushers].map((f) => Promise.resolve().then(f))).then(() =>
      window.api.invoke('app:flushed')
    )
  })
}
