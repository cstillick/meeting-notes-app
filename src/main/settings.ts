import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_MODEL, type SettingsUpdate, type SettingsView } from '@shared/types'

interface StoredSettings {
  /** base64 of safeStorage-encrypted key, or null */
  deepgramKeyEnc: string | null
  anthropicKeyEnc: string | null
  voyageKeyEnc: string | null
  model: string
}

const DEFAULTS: StoredSettings = {
  deepgramKeyEnc: null,
  anthropicKeyEnc: null,
  voyageKeyEnc: null,
  model: DEFAULT_MODEL
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: StoredSettings | null = null

function load(): StoredSettings {
  if (cache) return cache
  try {
    if (existsSync(settingsPath())) {
      cache = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
      return cache!
    }
  } catch (err) {
    console.error('settings: failed to read, using defaults', err)
  }
  cache = { ...DEFAULTS }
  return cache
}

function persist(s: StoredSettings): void {
  cache = s
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption unavailable')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(enc: string | null): string | null {
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch (err) {
    console.error('settings: failed to decrypt stored key', err)
    return null
  }
}

export function getSettingsView(): SettingsView {
  const s = load()
  return {
    deepgramKeySet: s.deepgramKeyEnc !== null,
    anthropicKeySet: s.anthropicKeyEnc !== null,
    voyageKeySet: s.voyageKeyEnc !== null,
    model: s.model
  }
}

export function updateSettings(update: SettingsUpdate): SettingsView {
  const s = { ...load() }
  if (update.deepgramKey !== undefined) {
    const key = update.deepgramKey?.trim()
    s.deepgramKeyEnc = key ? encrypt(key) : null
  }
  if (update.anthropicKey !== undefined) {
    const key = update.anthropicKey?.trim()
    s.anthropicKeyEnc = key ? encrypt(key) : null
  }
  if (update.voyageKey !== undefined) {
    const key = update.voyageKey?.trim()
    s.voyageKeyEnc = key ? encrypt(key) : null
  }
  if (update.model !== undefined && update.model.trim()) {
    s.model = update.model.trim()
  }
  persist(s)
  return getSettingsView()
}

/** Main-process-only accessors for the actual key material.
 *  Trim defensively: keys saved before trim-on-save may carry pasted whitespace. */
export function getDeepgramKey(): string | null {
  return decrypt(load().deepgramKeyEnc)?.trim() || null
}

export function getAnthropicKey(): string | null {
  return decrypt(load().anthropicKeyEnc)?.trim() || null
}

export function getVoyageKey(): string | null {
  return decrypt(load().voyageKeyEnc)?.trim() || null
}

export function getModel(): string {
  return load().model
}
