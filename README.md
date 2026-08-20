# Granola Clone

An AI meeting notepad for macOS, modeled on [Granola](https://granola.ai): no bot joins your
meeting — the app captures your **microphone** and **system audio** directly, transcribes both
live, and then uses Claude to merge your rough typed notes with the transcript into structured,
enhanced notes. Your own words render **black**; AI-added context renders gray.

Beyond capture, the library is a knowledge system: notes live in SQLite with full-text and
vector indexes, a **knowledge graph** ties concepts together across notes (in-app graph view),
meetings can **auto-record from your calendar**, audio/video files import with diarized
transcription, everything exports (Obsidian vault, Notion, Markdown/HTML/PDF/DOCX, JSON), and a
25-tool **MCP server** lets AI agents read, search, write, organize, record, and export — the
library doubles as a database an agent can keep referring back to.

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

## Ask Claude about your notes (MCP server)

`src/mcp/` is a [Model Context Protocol](https://modelcontextprotocol.io) server that hands the
note library to any MCP client — Claude Desktop, Claude Code — as 25 tools. It is a plain Node
process that opens `granola-clone.db` directly, so reads and library writes work whether or not
the app is running. Reads go through a read-only handle; each write op opens its own short-lived
handle, maintains the FTS index inline, and hands chunking/embedding/graph extraction to the app
via NULL stamps (`chunked_at`, `entities_at`) plus a change notification over the app's control
socket, so a running app refreshes instantly and a closed one catches up at launch. Set
`GRANOLA_MCP_READONLY=1` in the server's environment to disable every write tool.

Actions that need the app's keys or audio stack — live recording, file transcription, exports,
Notion — are relayed to the running app over a token-guarded unix socket in `userData/`
(`control.sock` + `control.token`, 0600, fresh token per launch) and fail with a clear "launch
the app" message otherwise.

| Tool | What it answers |
| --- | --- |
| `topics` | Groups the library by the leading number in each title, with sizes and which folders each group straddles. The entry point for a course or phased project |
| `outline` | Every title in one compact call — the table of contents. Numeric-aware ordering, so `2.2.10` sorts after `2.2.4` |
| `search_notes` | bm25 search over titles (weighted 10×), notes, enhanced notes and transcripts, with snippets |
| `search_transcript` | Exact spoken words with timestamps and context. Terms ≤3 chars match as whole words so `AI` doesn't match *said*; longer terms match inside words so `bill` finds *billing* |
| `get_notes` | Reads up to 200 notes in one call, with a size-proportional character budget and an exact account of what it withheld |
| `get_note` | One note: rough notes, enhanced notes, transcript |
| `get_transcript` | Paged, timestamped, speaker-labelled transcript |
| `list_notes` | Browse by recency, folder, title filter, status, date range |
| `list_folders` | Folders and their note counts |
| `library_overview` | Counts, date range, folders — orientation before searching |
| `get_graph` | The knowledge graph: concepts/people/orgs/topics with the notes each ties together |
| `related_notes` | Notes sharing a note's concepts, strongest ties first, with the shared concepts named |
| `create_note` / `update_note` | Write to the library: new notes from Markdown; append/replace rough notes, retitle, move between folders. Never touches transcripts or enhanced notes |
| `create_folder` / `rename_folder` | Organize the library |
| `delete_note` / `delete_folder` | Two-step: first call reports what would be lost and returns a confirmation token; only repeating with the token deletes |
| `import_recording` | Transcribe a local audio/video file into a new note (app must be running) |
| `start_recording` / `stop_recording` / `recording_status` | Drive live meeting capture (app must be running) |
| `export_note` / `export_library` / `export_to_notion` | Files (md/html/pdf/docx), Obsidian vault or JSON bundle, Notion pages (app must be running) |

**Numbered libraries.** Course notes titled `2.1.4 …` defeat full-text search, because FTS tokenizes
that into the separate numbers 2, 1 and 4. Worse, the numbering often does not match the folders —
in the author's library 8 of the 46 topic-2 notes were never filed, including the largest reading
assignment, so a folder-scoped answer silently dropped them. `topics` exposes the real grouping;
`title_starts_with` selects a group (anchored, because `title_contains: "2."` also matches
`1.2.10`); `outline` warns when a folder filter is excluding matches that live outside it.

**Honest budgets.** `get_notes` distinguishes "there is nothing here" from "there was no room for
it" — the earlier version rendered `(no transcript recorded)` for a note with 1,027 spoken lines
once the budget ran out, which is a false statement about the user's data rather than a truncation.
Every response reports characters shown and characters withheld, and names the notes it cut short.

Search deliberately mirrors the in-app chat's retrieval: the same FTS5 index, the same
stopword handling, all-terms first and any-term ranked by bm25 as a fallback.

### Claude Desktop — install as an extension (the durable route)

```bash
npm run build:mcpb   # → dist/notetaker.mcpb
```

Then in Claude Desktop: **Settings → Extensions**, and install the `.mcpb` from file (drag it
onto the window, or use the install option under Advanced settings). Unsigned local bundles
install fine — Desktop just logs `Installing unsigned extension`.

The build compiles the server to plain JS, vendors the SDK, and generates `manifest.json`
**from the server's own `tools/list`**, so the manifest can never drift from what the server
advertises and a bundle that cannot boot fails the build rather than installing silently. The
manifest is checked against the published `@anthropic-ai/mcpb` schema, which is strict
(`additionalProperties: false`) — one stray field is an install failure with no useful message.

Desktop runs extensions under its **own** Node (Electron 42 → Node 24.16, which has `node:sqlite`
with FTS5), so the bundle assumes nothing about the user's node install.

> Debugging note: Desktop names the per-server log after `display_name`, not `name` — so it is
> `~/Library/Logs/Claude/mcp-server-Notetaker.log`, **not** `…notetaker.log`. Watching
> the wrong filename looks exactly like "the extension never loaded".

#### Why not `claude_desktop_config.json`?

That route still works — the app parses and validates `mcpServers` — but it is fragile: Claude
Desktop memoizes the config on first read and writes the whole cached object back, so **any
hand-edit made while Desktop is running is silently discarded**, with no merge and no warning.
An entry added that way disappeared once already. If you do use it, edit only while Desktop is
fully quit, and note that `command` must be an **absolute** path to node — Desktop spawns
servers with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that has no Homebrew node.

### Claude Code

```bash
claude mcp add notetaker -- /opt/homebrew/bin/node "/Users/cstillick/Desktop/Granola Clone/src/mcp/server.ts"
```

### Running it directly

```bash
npm run mcp
```

It picks the newest of `~/Library/Application Support/{granola-clone,Granola Clone}/granola-clone.db`
(dev vs packaged). `GRANOLA_DB_PATH=/path/to/db` overrides that — which is how the stress suite
points it at a sandbox. Diagnostics go to stderr; stdout is JSON-RPC only.

`scripts/stress/mcp-tools.ts` covers this end to end: it seeds a library through the real app
code, asserts every tool's ranking/scoping/paging/truncation, and then spawns the server with
plain `node` — no loader hooks, no Electron — and runs a live JSON-RPC handshake, which is the
check that catches the server's one import from `src/main/` growing an Electron dependency.

Note this is a *local stdio* server. Custom connectors on **claude.ai** (web/mobile) must be
remote HTTP servers with a public URL, which would mean tunnelling the library off this Mac.

## Knowledge graph

Claude (Haiku, background) extracts each note's key **concepts, people, organizations, and
topics** into an entity graph (`entities` / `note_entities`, migration v10). Extraction runs
after enhancement, imports, recording stops, and MCP writes — driven by an `entities_at` NULL
stamp exactly like the chunk backfill — and needs only the Anthropic key already in Settings.

- **Graph** (Home header) opens the interactive view: notes (amber) and concepts (by kind) in a
  force layout; hover to highlight, click a concept to list its notes, click a note to open it,
  filter by folder, `Rebuild` to re-extract everything.
- Each note shows **Related notes** — the notes sharing its concepts and why.
- Agents get the same structure through `get_graph` and `related_notes`.
- The Obsidian vault export mirrors the graph with `[[wikilinks]]` and `Concepts/` stub pages,
  so Obsidian's graph view renders it too.

## Import recordings

**Import** (Home header) transcribes local audio/video files — mp3, wav, m4a, aac, flac, ogg,
opus, webm, mp4, m4v, mov, mkv — through Deepgram's pre-recorded API with speaker diarization.
Each file becomes a normal note (search, chat, enhance, graph all apply). Agents can do the same
with the `import_recording` MCP tool.

## Calendar auto-record

Settings → **Auto-record calendar meetings**. A one-shot Swift EventKit helper
(`native/calendarpeek`) is polled every minute; when an event with attendees or a meeting link
reaches its start, the app creates a note titled after the event and starts recording (up to
1 minute early, and never more than 10 minutes late). Turning the setting on triggers the macOS
calendar-permission prompt. Solo timed events ("Dentist") are left alone.

## Exporting

- **Per note** (note header → Export): Markdown with frontmatter, standalone HTML, PDF, DOCX —
  all including the transcript — or straight to Notion.
- **Library / folder** (Home header → Export): an **Obsidian vault** (wikilinked Markdown +
  concept stubs; open the folder as a vault and the graph is there), a **JSON bundle**
  (schema-versioned full export: markdown, transcripts, concepts, relations — backup and agent
  corpus in one), or **Notion** (a container page with one child page per note).
- **Notion setup**: create an internal integration at notion.so/my-integrations, paste its token
  and a parent page id/URL into Settings, and share that page with the integration.

## Packaging

```bash
npm run build   # → dist/mac-arm64/Granola Clone.app (ad-hoc signed)
```

## Known limitations

- **Echo without headphones**: Chromium's echo cancellation only cancels audio Chromium
  itself plays, not Zoom/Meet output. On speakers, "Them" audio can leak into the "Me"
  channel. Wear headphones, or enable macOS Voice Isolation (Control Center → Mic Mode).
  Real cross-app AEC is the headline item Granola built custom.
- Back-to-back calls that keep the mic open merge into one detection window.
- Knowledge-graph extraction re-runs on enhancement/import/recording/MCP writes, but plain
  typing in the rough editor doesn't re-trigger it until one of those events (or Graph →
  Rebuild).
- No templates or sharing yet.

## Project layout

- `src/main/transcription/recorder.ts` — the heart: meeting lifecycle, audio routing
- `src/main/transcription/importer.ts` — audio/video file → Deepgram pre-recorded → note
- `src/main/audio/` — audiotee + micmonitor process lifecycles
- `src/main/enhance/` — Claude prompt + streaming; `pmToMarkdown.ts` round-trips manual edits
- `src/main/graph/extractor.ts` — background knowledge-graph entity extraction (Haiku)
- `src/main/export/` — Markdown/Obsidian vault, HTML, PDF, DOCX (hand-rolled OOXML+zip),
  JSON bundle, Notion
- `src/main/control.ts` — token-guarded unix socket: agent notifications, recording control,
  imports, exports
- `src/main/calendar.ts` — calendar polling + auto-record
- `src/mcp/` — the 25-tool MCP server (reads, writes, graph, recording, import, export)
- `src/shared/ipc.ts` — the typed IPC contract every layer shares
- `native/micmonitor/`, `native/calendarpeek/` — Swift helpers (`./build.sh` each)
- `resources/bin/` — vendored helper binaries (audiotee built from
  [makeusabrew/audiotee](https://github.com/makeusabrew/audiotee))
