import type { Theme } from '@shared/types'

/** Mirrors the persisted appearance choice so the very first paint can pick the
 *  right theme synchronously — settings.json only arrives later over async IPC. */
const THEME_KEY = 'granola-theme'

const THEMES: readonly Theme[] = ['light', 'dark', 'system']

const prefersDark = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

/** Last preference applied, so the system-change listener knows whether to act. */
let current: Theme = 'system'
let mediaQuery: MediaQueryList | null = null

function onSystemChange(): void {
  if (current === 'system') paint('system')
}

/** Toggle the `dark` class on <html>; Tailwind utilities resolve their colors
 *  from the palette variables we redefine under `html.dark`. */
function paint(pref: Theme): void {
  const dark = pref === 'dark' || (pref === 'system' && prefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

/** Read the cached preference written by the last applyTheme() call. */
export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY) as Theme | null
    if (v && THEMES.includes(v)) return v
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return 'system'
}

/** Apply a preference now, cache it, and keep tracking the OS when set to system. */
export function applyTheme(pref: Theme): void {
  current = THEMES.includes(pref) ? pref : 'system'
  try {
    localStorage.setItem(THEME_KEY, current)
  } catch {
    /* ignore persistence failure; the class toggle below still applies */
  }

  if (typeof window.matchMedia === 'function') {
    if (!mediaQuery) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', onSystemChange)
    }
  }

  paint(current)
}
