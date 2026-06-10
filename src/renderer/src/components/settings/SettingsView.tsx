import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (settings) setModel(settings.model)
  }, [settings])

  async function onSave(): Promise<void> {
    await save({
      ...(deepgramKey ? { deepgramKey } : {}),
      ...(anthropicKey ? { anthropicKey } : {}),
      model
    })
    setDeepgramKey('')
    setAnthropicKey('')
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
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">Claude model</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
            />
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
            They never leave this machine except in requests to Deepgram and Anthropic.
          </p>
        </div>
      </main>
    </div>
  )
}
