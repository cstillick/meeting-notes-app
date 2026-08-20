import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_MODEL,
  modelCapabilities,
  type ModelOption,
  type SettingsUpdate,
  type SettingsView
} from '@shared/types'

interface StoredSettings {
  /** base64 of safeStorage-encrypted key, or null */
  deepgramKeyEnc: string | null
  anthropicKeyEnc: string | null
  voyageKeyEnc: string | null
  model: string
  /** Record system audio only — skip the microphone entirely. */
  systemAudioOnly: boolean
  /** Start recording automatically when a calendar meeting begins. */
  calendarAutoRecord: boolean
  /** Notion internal-integration token (for Export to Notion), encrypted. */
  notionTokenEnc: string | null
  /** Notion page id under which exports are created (not secret). */
  notionParentPageId: string
}

const DEFAULTS: StoredSettings = {
  deepgramKeyEnc: null,
  anthropicKeyEnc: null,
  voyageKeyEnc: null,
  model: DEFAULT_MODEL,
  systemAudioOnly: false,
  calendarAutoRecord: false,
  notionTokenEnc: null,
  notionParentPageId: ''
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
  // "Set" means decryptable, not merely present: after a keychain change or a
  // userData copy from another machine, decrypt fails and every consumer
  // behaves as if the key were absent — Settings must not claim otherwise, or
  // the user has no signal to re-enter the key.
  return {
    deepgramKeySet: !!decrypt(s.deepgramKeyEnc)?.trim(),
    anthropicKeySet: !!decrypt(s.anthropicKeyEnc)?.trim(),
    voyageKeySet: !!decrypt(s.voyageKeyEnc)?.trim(),
    model: s.model,
    systemAudioOnly: s.systemAudioOnly,
    calendarAutoRecord: s.calendarAutoRecord,
    notionTokenSet: !!decrypt(s.notionTokenEnc)?.trim(),
    notionParentPageId: s.notionParentPageId
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
  if (update.systemAudioOnly !== undefined) {
    s.systemAudioOnly = update.systemAudioOnly
  }
  if (update.calendarAutoRecord !== undefined) {
    s.calendarAutoRecord = update.calendarAutoRecord
  }
  if (update.notionToken !== undefined) {
    const key = update.notionToken?.trim()
    s.notionTokenEnc = key ? encrypt(key) : null
  }
  if (update.notionParentPageId !== undefined) {
    s.notionParentPageId = update.notionParentPageId.trim()
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

/** Capabilities of the selected model. Every Anthropic request derives its
 *  shape (thinking config) and its context budget from this one call, so the
 *  chat and enhance paths can never disagree about what the model accepts.
 *  `.id` is the model string to send — for a custom model it is what the user
 *  stored, verbatim. */
export function getModelCapabilities(): ModelOption {
  return modelCapabilities(getModel())
}

export function getSystemAudioOnly(): boolean {
  return load().systemAudioOnly
}

export function getCalendarAutoRecord(): boolean {
  return load().calendarAutoRecord
}

export function getNotionToken(): string | null {
  return decrypt(load().notionTokenEnc)?.trim() || null
}

export function getNotionParentPageId(): string {
  return load().notionParentPageId
}
