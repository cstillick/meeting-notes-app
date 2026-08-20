import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AVAILABLE_MODELS } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'

function KeyField({
  label,
  placeholder,
  isSet,
  value,
  onChange
}: {
  label: string
  placeholder: string
  isSet: boolean
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-stone-700">{label}</span>
        {isSet && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            key set
          </span>
        )}
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isSet ? '•••••••• (enter a new key to replace)' : placeholder}
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
      />
    </label>
  )
}

export default function SettingsView(): React.JSX.Element {
  const { settings, load, save } = useSettingsStore()
  const [deepgramKey, setDeepgramKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [voyageKey, setVoyageKey] = useState('')
  const [notionToken, setNotionToken] = useState('')
  const [notionParentPageId, setNotionParentPageId] = useState('')
  const [model, setModel] = useState('')
  const [systemAudioOnly, setSystemAudioOnly] = useState(false)
  const [calendarAutoRecord, setCalendarAutoRecord] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (settings) {
      setModel(settings.model)
      setSystemAudioOnly(settings.systemAudioOnly)
      setCalendarAutoRecord(settings.calendarAutoRecord)
      setNotionParentPageId(settings.notionParentPageId)
    }
  }, [settings])

  async function onSave(): Promise<void> {
    await save({
      ...(deepgramKey ? { deepgramKey } : {}),
      ...(anthropicKey ? { anthropicKey } : {}),
      ...(voyageKey ? { voyageKey } : {}),
      ...(notionToken ? { notionToken } : {}),
      notionParentPageId,
      model,
      systemAudioOnly,
      calendarAutoRecord
    })
    setDeepgramKey('')
    setAnthropicKey('')
    setVoyageKey('')
    setNotionToken('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="drag-region flex items-center gap-3 border-b border-stone-200 bg-stone-50/90 px-6 pt-3 pb-3 pl-24">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-700">
          ← Back
        </Link>
        <h1 className="text-sm font-semibold tracking-wide text-stone-500">Settings</h1>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-md space-y-6">
          <KeyField
            label="Deepgram API key"
            placeholder="Used for live transcription"
            isSet={settings?.deepgramKeySet ?? false}
            value={deepgramKey}
            onChange={setDeepgramKey}
          />
          <KeyField
            label="Anthropic API key"
            placeholder="Used to enhance your notes"
            isSet={settings?.anthropicKeySet ?? false}
            value={anthropicKey}
            onChange={setAnthropicKey}
          />
          <div>
            <KeyField
              label="Voyage AI API key (optional)"
              placeholder="Enables semantic search in chat"
              isSet={settings?.voyageKeySet ?? false}
              value={voyageKey}
              onChange={setVoyageKey}
            />
            <span className="mt-1 block text-xs text-stone-400">
              Without it, cross-note chat uses keyword search only. Get a key at voyageai.com.
            </span>
          </div>
          <div>
            <KeyField
              label="Notion integration token (optional)"
              placeholder="Enables Export to Notion"
              isSet={settings?.notionTokenSet ?? false}
              value={notionToken}
              onChange={setNotionToken}
            />
            <label className="mt-2 block">
              <span className="mb-1 block text-sm font-medium text-stone-700">
                Notion parent page
              </span>
              <input
                type="text"
                value={notionParentPageId}
                onChange={(e) => setNotionParentPageId(e.target.value)}
                placeholder="Page id or URL exports are created under"
                className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
              />
            </label>
            <span className="mt-1 block text-xs text-stone-400">
              Create an internal integration at notion.so/my-integrations, then share the parent
              page with it (page menu → Connections).
            </span>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Claude model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {model && !AVAILABLE_MODELS.some((m) => m.id === model) && (
                <option value={model}>{model} (custom)</option>
              )}
            </select>
            <span className="mt-1 block text-xs text-stone-400">
              {AVAILABLE_MODELS.find((m) => m.id === model)?.hint ??
                'Used to enhance notes and answer chat questions.'}
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={systemAudioOnly}
              onChange={(e) => setSystemAudioOnly(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
            />
            <span>
              <span className="block text-sm font-medium text-stone-700">
                Mute microphone (record system audio only)
              </span>
              <span className="mt-0.5 block text-xs text-stone-400">
                Captures only what other participants say — your mic is never opened. Takes effect on
                the next recording you start.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={calendarAutoRecord}
              onChange={(e) => setCalendarAutoRecord(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
            />
            <span>
              <span className="block text-sm font-medium text-stone-700">
                Auto-record calendar meetings
              </span>
              <span className="mt-0.5 block text-xs text-stone-400">
                When a calendar event with attendees or a meeting link starts, recording begins
                automatically with a note titled after the event. Saving with this on asks macOS for
                calendar access the first time.
              </span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={onSave}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
            >
              Save
            </button>
            {saved && <span className="text-sm text-green-600">Saved</span>}
          </div>
          <p className="text-xs leading-relaxed text-stone-400">
            Keys are encrypted with the macOS keychain (Electron safeStorage) and stored locally.
            They never leave this machine except in requests to Deepgram, Anthropic, and Voyage.
          </p>
        </div>
      </main>
    </div>
  )
}
