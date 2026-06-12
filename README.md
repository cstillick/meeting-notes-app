# My Personal Meeting Transcriber with AI Enhancement Notes App (Granola Clone)

An AI meeting notepad for macOS, modeled on [Granola](https://granola.ai): no bot joins your
meeting — the app captures your **microphone** and **system audio** directly, transcribes both
live, and then uses Claude to merge your rough typed notes with the transcript into structured,
enhanced notes. Your own words render **black**; AI-added context renders gray.

## How it works

```
Mic:    getUserMedia (AEC on) → AudioWorklet (48k→16k s16le) → Deepgram WS #1 → "Me"
System: audiotee helper (Core Audio process tap) ───────────→ Deepgram WS #2 → "Them"
                       ↓ finals only
                    SQLite (node:sqlite, FTS5)
                       ↓ on "Enhance"
   transcript + rough notes → claude-opus-4-8 → markdown with ⟦U⟧ user-text sentinels
                       ↓
        TipTap doc: your words black, AI text gray
```

- Speaker labels are **channel-based** (mic = Me, system = Them) — exactly how the real
  Granola does it; no acoustic diarization needed.
- Audio is never written to disk. PCM exists only in memory and the outbound Deepgram
  websockets; only transcript text persists.
- A `micmonitor` helper watches for other apps using the microphone and offers to start
  notes when a meeting begins.

## Requirements

- macOS 14.2+ (Core Audio process taps), Apple Silicon
- A [Deepgram API key](https://console.deepgram.com) (free credit tier available)
- An [Anthropic API key](https://console.anthropic.com)
- Optional: a [Voyage AI API key](https://www.voyageai.com) — enables semantic (embedding)
  search for cross-note and folder chat. Without it, chat retrieval is keyword-only.

## Setup

```bash
npm install
npm run fix-electron-plist   # dev-only; no-op on Electron ≥42 (keys already present)
npm run dev
```

Then open **Settings** in the app and paste both API keys (stored encrypted via the macOS
keychain / Electron safeStorage).

### Permissions (first run)

1. **Microphone** — prompted automatically when you first hit Record.
2. **System audio** — macOS prompts for "System Audio Recording". If the prompt doesn't
   appear or capture is silent, grant it manually: System Settings → Privacy & Security →
   Screen & System Audio Recording → enable for Electron (dev) / Granola Clone (packaged).
   A silent "Them" channel with a working "Me" channel almost always means this permission
   is missing — the tap delivers zeros instead of erroring.

## Verifying the core loop

1. `npm run dev`, enter both API keys in Settings.
2. **New note** → **Record** → play a YouTube interview (this simulates "Them") while
   saying a few sentences yourself ("Me"). Bubbles should appear within ~1s — wear
   headphones to keep your voice out of the system channel.
3. Type 3–4 rough bullets in the editor while it records.
4. **Stop** → **✨ Enhance** → watch enhanced notes stream in; your phrases stay black,
   AI-added context is gray. The meeting auto-titles from the result.
5. Relaunch — everything persists. Search any word that was only spoken (not typed).
6. Join a Zoom/FaceTime call without recording → "Looks like a meeting started" banner.

## Packaging

```bash
npm run build   # → dist/mac-arm64/Granola Clone.app (ad-hoc signed)
```

## Known limitations (MVP)

- **Echo without headphones**: Chromium's echo cancellation only cancels audio Chromium
  itself plays, not Zoom/Meet output. On speakers, "Them" audio can leak into the "Me"
  channel. Wear headphones, or enable macOS Voice Isolation (Control Center → Mic Mode).
  Real cross-app AEC is the headline post-MVP item (it's the thing Granola built custom).
- Back-to-back calls that keep the mic open merge into one detection window.
- No calendar integration, templates, chat-with-meetings, or sharing yet — see
  the build plan for the phased roadmap.

## Project layout

- `src/main/transcription/recorder.ts` — the heart: meeting lifecycle, audio routing
- `src/main/audio/` — audiotee + micmonitor process lifecycles
- `src/main/enhance/` — Claude prompt + streaming
- `src/shared/ipc.ts` — the typed IPC contract every layer shares
- `native/micmonitor/` — Swift source for the mic-in-use helper (`./build.sh`)
- `resources/bin/` — vendored helper binaries (audiotee built from
  [makeusabrew/audiotee](https://github.com/makeusabrew/audiotee))
