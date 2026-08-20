#!/usr/bin/env node
// MCP server exposing the Notetaker library to any MCP client
// (Claude Desktop, Claude Code). Read-only by construction: see db.ts.
//
// Run:   node src/mcp/server.ts          (npm run mcp)
// Point at a specific library:  GRANOLA_DB_PATH=/path/to/granola-clone.db
//
// stdio transport — stdout carries JSON-RPC frames and nothing else.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { candidateDbPaths, openLibrary, resolveDbPath, type Library } from './db.ts'
import {
  createFolderTool,
  createNoteTool,
  deleteFolderTool,
  deleteNoteTool,
  importRecordingTool,
  exportLibraryTool,
  exportNoteTool,
  exportNotionTool,
  getGraphTool,
  relatedNotesTool,
  recordingStatusTool,
  startRecordingTool,
  stopRecordingTool,
  getNoteTool,
  getNotesTool,
  getTranscriptTool,
  libraryOverview,
  listFoldersTool,
  listNotesTool,
  outlineTool,
  renameFolderTool,
  topicsTool,
  searchNotesTool,
  searchTranscriptTool,
  updateNoteTool
} from './tools.ts'

/** Write tools can be disabled wholesale (e.g. for a shared machine or a
 *  deployment that should only ever read): GRANOLA_MCP_READONLY=1. */
const WRITES_ENABLED = !process.env.GRANOLA_MCP_READONLY

// One stray console.log would land in the middle of a JSON-RPC frame and kill
// the session. Everything diagnostic goes to stderr, which the client logs.
console.log = console.error
console.info = console.error
console.debug = console.error
console.warn = console.error

// ---------------------------------------------------------------------------
// Library handle
// ---------------------------------------------------------------------------

let library: Library | null = null

/** Opened on first use, not at startup: a missing database should surface as a
 *  readable tool error inside the conversation, not as a server that refuses to
 *  boot and shows up in Claude Desktop as simply broken. */
function lib(): Library {
  if (library) return library
  const path = resolveDbPath()
  if (!path) {
    throw new Error(
      `No Notetaker library found. Looked in:\n${candidateDbPaths()
        .map((p) => `  ${p}`)
        .join('\n')}\nRun the app once to create it, or set GRANOLA_DB_PATH.`
    )
  }
  library = openLibrary(path)
  console.error(`notetaker: opened ${library.path} (${library.mode})`)
  return library
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'notetaker', version: '0.2.0' },
  {
    instructions: `The user's Notetaker library: everything they recorded, the transcript of what was said (their microphone is "Me", other voices come from system audio), the rough notes they typed at the time, and the AI-enhanced notes written afterwards. Notes are organised into folders.

Use these tools whenever the user refers to a meeting, a call, a class, a lecture, or "my notes" — including questions they may not realise are answerable, like what someone committed to or when a topic last came up.

PICK THE RIGHT ENTRY POINT:
- A specific topic or phrase -> search_notes. Ranks whole notes across titles, typed notes, enhanced notes and transcripts, with titles weighted heavily.
- Exact words, a quote, or "who said..." -> search_transcript. Returns timestamped lines.
- "What is in this folder / class / project", or anything covering a WHOLE subject area -> outline first. It returns every title in a folder in one cheap call. Read the titles before deciding what to open: they often reveal structure no search query can reach.
- Reading one note -> get_note. Reading MANY -> get_notes, which takes a list of ids in a single call.

NUMBERED LIBRARIES. A library used for a course or a phased project numbers its notes, e.g. "2.1.4 Watch Solution to Practice Problem...". Full-text search cannot reach that structure: "2.1.4" tokenises into the separate numbers 2, 1 and 4. Worse, the numbering often does NOT line up with the folders — a topic can be split between a folder and the unfiled notes, so a folder-scoped answer quietly misses part of it. For "what should I know for topic 2":
  1. topics — see the real groups, their sizes, and which folders they straddle.
  2. outline with title_starts_with: "2." and NO folder argument, order: "title".
  3. get_notes with those ids. Raise max_chars for a large group; it reports exactly how much it withheld.
Do not answer a "cover this whole topic" question from a handful of search hits when topics shows forty notes in scope. State what you read and what you did not.

THE KNOWLEDGE GRAPH. Every note's key concepts, people, organizations and topics are extracted into a graph. get_graph surveys how subjects connect across the library (or one folder); related_notes walks from one note to the notes that share its concepts — the tool for research loops that keep referring back ("what else do I have on fiscal multipliers?"). get_note lists each note's concepts inline.

EXPORTING. export_note writes one note as Markdown, HTML, PDF, or DOCX; export_library writes the whole library or one folder as an Obsidian vault (wikilinked Markdown mirroring the knowledge graph) or as one machine-readable JSON bundle; export_to_notion pushes notes into the user's Notion workspace. These need the app running.

WRITING. The library is also writable: create_note starts a new note (Markdown content becomes an ordinary editable document), update_note appends to or replaces a note's rough notes, retitles it, or moves it between folders, and create_folder/rename_folder organise the library. Use these for research workflows — save syntheses, reading notes, and follow-ups back into the folder they belong to, so later sessions can build on them. Writes never touch the transcript or the AI-enhanced notes; those stay exactly as recorded. delete_note and delete_folder are two-step: the first call tells you what would be lost and returns a confirmation token, and only repeating the call with that token deletes anything. Never delete without being asked to.

Everything is local to this Mac.`
  }
)

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

/** Tool bodies throw plain Errors for user-fixable problems (unknown folder,
 *  bad id, missing database). Those belong in the conversation as text the
 *  model can act on, not as protocol errors. */
function run(body: () => string): ToolResult {
  try {
    return { content: [{ type: 'text', text: body() }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

/** run() for tool bodies that await the app over the control socket. */
async function runAsync(body: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await body() }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

const dateArgs = {
  after: z
    .string()
    .optional()
    .describe('Only notes created on or after this date (YYYY-MM-DD or ISO timestamp).'),
  before: z
    .string()
    .optional()
    .describe('Only notes created before the end of this date (YYYY-MM-DD or ISO timestamp).')
}

const folderArg = z
  .string()
  .optional()
  .describe('Restrict to one folder, by name or id. Use "unfiled" for notes in no folder.')

const titleArg = z
  .string()
  .optional()
  .describe(
    'Only notes whose TITLE contains this text. Case-insensitive substring, not full-text search — the way to select a numbered group, e.g. "2." for every note in topic 2 of a course.'
  )

const titleStartsArg = z
  .string()
  .optional()
  .describe(
    'Only notes whose TITLE STARTS WITH this text. Prefer this over title_contains for a numbered syllabus: "2." selects topic 2 without also matching "1.2.10".'
  )

server.registerTool(
  'library_overview',
  {
    title: 'Library overview',
    description:
      'Summary of the whole note library: how many notes exist, how many have transcripts or enhanced notes, the date range covered, and the folders. Call this first when you need to know what is available before searching.',
    inputSchema: {},
    annotations: { ...READ_ONLY, title: 'Library overview' }
  },
  () => run(() => libraryOverview(lib()))
)

server.registerTool(
  'list_folders',
  {
    title: 'List folders',
    description:
      'List every folder with its note count, plus how many notes are unfiled. Folder names can then be passed to list_notes, search_notes, or search_transcript.',
    inputSchema: {},
    annotations: { ...READ_ONLY, title: 'List folders' }
  },
  () => run(() => listFoldersTool(lib()))
)

server.registerTool(
  'list_notes',
  {
    title: 'List notes',
    description:
      'Browse notes newest-first, optionally filtered by folder, status, or date range. Use this for "what did I do last week" or to page through the library; use search_notes when you have a topic to look for.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25).describe('How many notes to return.'),
      offset: z.number().int().min(0).default(0).describe('Skip this many notes (for paging).'),
      folder: folderArg,
      title_contains: titleArg,
      title_starts_with: titleStartsArg,
      status: z
        .enum(['draft', 'recording', 'recorded', 'enhancing', 'enhanced'])
        .optional()
        .describe('Only notes in this state. "enhanced" means AI notes have been generated.'),
      ...dateArgs
    },
    annotations: { ...READ_ONLY, title: 'List notes' }
  },
  (args) => run(() => listNotesTool(lib(), args))
)

server.registerTool(
  'search_notes',
  {
    title: 'Search notes',
    description:
      'Primary search. Ranks whole notes by relevance across their titles, typed notes, enhanced notes, and full transcripts, and returns a matching snippet plus the note id for each hit. Pass the meaningful words of the question — common words are ignored, and if no note contains every term it falls back to ranking by any term. Follow up with get_note for the full text.',
    inputSchema: {
      query: z.string().min(1).describe('Words to search for, e.g. "pricing renewal Acme".'),
      limit: z.number().int().min(1).max(25).default(8).describe('How many notes to return.'),
      folder: folderArg,
      title_contains: titleArg,
      title_starts_with: titleStartsArg,
      ...dateArgs
    },
    annotations: { ...READ_ONLY, title: 'Search notes' }
  },
  (args) => run(() => searchNotesTool(lib(), args))
)

server.registerTool(
  'get_note',
  {
    title: 'Get note',
    description:
      'Full content of one note by id: the rough notes the user typed during the meeting and the AI-enhanced notes written from the transcript. Ask for the transcript too when you need what was actually said; long transcripts are truncated here, so use get_transcript to page through them.',
    inputSchema: {
      note_id: z.string().min(1).describe('Note id from a search or list result (a prefix works).'),
      include: z
        .array(z.enum(['rough_notes', 'enhanced_notes', 'transcript']))
        .min(1)
        .default(['rough_notes', 'enhanced_notes'])
        .describe('Which sections to return.'),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .default(40_000)
        .describe('Per-section character cap; truncation is reported in the output.')
    },
    annotations: { ...READ_ONLY, title: 'Get note' }
  },
  (args) => run(() => getNoteTool(lib(), args))
)

server.registerTool(
  'get_transcript',
  {
    title: 'Get transcript',
    description:
      'The verbatim transcript of one note, as timestamped speaker-labelled lines ("Me" is the user; other speakers were captured from system audio). Paged — the result says how many lines remain and which offset to ask for next.',
    inputSchema: {
      note_id: z.string().min(1).describe('Note id from a search or list result (a prefix works).'),
      offset: z.number().int().min(0).default(0).describe('First transcript line to return.'),
      limit: z.number().int().min(1).max(2000).default(300).describe('How many lines to return.')
    },
    annotations: { ...READ_ONLY, title: 'Get transcript' }
  },
  (args) => run(() => getTranscriptTool(lib(), args))
)

server.registerTool(
  'search_transcript',
  {
    title: 'Search spoken words',
    description:
      'Find exact spoken words across transcripts and return the matching lines with timestamps and surrounding context. Every term must appear in the same spoken line; terms of 1-3 characters match as whole words (so "AI" does not match "said"), longer terms match inside words (so "bill" finds "billing"). The right tool for quotes, names, numbers, and "who said…" or "did anyone mention…" questions. Scope it with note_id or folder when you already know where to look.',
    inputSchema: {
      query: z.string().min(1).describe('Words that must all appear in the spoken line.'),
      limit: z.number().int().min(1).max(50).default(20).describe('How many matching lines to return.'),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe('Transcript lines to show either side of each match.'),
      note_id: z.string().optional().describe('Search only within this note.'),
      folder: folderArg,
      ...dateArgs
    },
    annotations: { ...READ_ONLY, title: 'Search spoken words' }
  },
  (args) => run(() => searchTranscriptTool(lib(), args))
)

server.registerTool(
  'topics',
  {
    title: 'Topic groups',
    description:
      'Group the library by the leading number in each note title, with note counts, total size, and which folders each group is spread across. Call this FIRST for any question about a course, class, unit, module or numbered project — it reveals the real structure, which folders often do not match: a group can be split across a folder and the unfiled notes. Follow with outline(title_starts_with) and get_notes.',
    inputSchema: { folder: folderArg },
    annotations: { ...READ_ONLY, title: 'Topic groups' }
  },
  (args) => run(() => topicsTool(lib(), args))
)

server.registerTool(
  'outline',
  {
    title: 'Outline a folder',
    description:
      'Every note title in a folder (or the whole library) in one compact call — the table of contents. Start here for "what is in this class/project", or for any question that spans a whole subject rather than one meeting. Titles often carry structure that search cannot see: a course numbers its notes "1.1.1", "2.1.4", so ordering by title reveals the syllabus. Each line begins with a short note id you can pass straight to get_notes.',
    inputSchema: {
      folder: folderArg,
      title_contains: titleArg,
      title_starts_with: titleStartsArg,
      status: z
        .enum(['draft', 'recording', 'recorded', 'enhancing', 'enhanced'])
        .optional()
        .describe('Only notes in this state.'),
      order: z
        .enum(['title', 'newest'])
        .default('title')
        .describe('"title" groups a numbered syllabus in reading order; "newest" is date order.'),
      limit: z.number().int().min(1).max(1000).default(300).describe('Maximum titles to return.'),
      ...dateArgs
    },
    annotations: { ...READ_ONLY, title: 'Outline a folder' }
  },
  (args) => run(() => outlineTool(lib(), args))
)

server.registerTool(
  'get_graph',
  {
    title: 'Knowledge graph',
    description:
      'The knowledge graph of the library (or one folder): the extracted concepts, people, organizations, and topics, each with the notes it ties together. The map of how subjects connect across notes — start here for "how does X relate to Y" or to survey a research area, then follow note ids into get_notes or walk outward with related_notes.',
    inputSchema: {
      folder: folderArg,
      limit: z.number().int().min(1).max(200).default(40).describe('Maximum concepts to return.')
    },
    annotations: { ...READ_ONLY, title: 'Knowledge graph' }
  },
  (args) => run(() => getGraphTool(lib(), args))
)

server.registerTool(
  'related_notes',
  {
    title: 'Related notes',
    description:
      'Notes connected to one note through shared knowledge-graph concepts, strongest ties first, with the shared concepts named. The way to "keep referring back" while researching: read a note, pull its relations, follow them.',
    inputSchema: {
      note_id: z.string().min(1).describe('Note id from a search or list result (a prefix works).'),
      limit: z.number().int().min(1).max(50).default(10).describe('How many related notes.')
    },
    annotations: { ...READ_ONLY, title: 'Related notes' }
  },
  (args) => run(() => relatedNotesTool(lib(), args))
)

server.registerTool(
  'recording_status',
  {
    title: 'Recording status',
    description:
      'Whether the app is currently recording a meeting, and which note. Requires the Granola Clone app to be running.',
    inputSchema: {},
    annotations: { ...READ_ONLY, title: 'Recording status' }
  },
  () => runAsync(() => recordingStatusTool(lib()))
)

server.registerTool(
  'get_notes',
  {
    title: 'Get several notes',
    description:
      'Read many notes in ONE call. Use this whenever a question spans more than a couple of notes — a whole course topic, a project, a run of meetings — instead of calling get_note repeatedly. The character budget is shared across the set, and any notes that did not fit are named explicitly so you can say what you did not read.',
    inputSchema: {
      note_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe('Note ids (short ids from outline are fine).'),
      include: z
        .array(z.enum(['rough_notes', 'enhanced_notes', 'transcript']))
        .min(1)
        .default(['enhanced_notes', 'rough_notes'])
        .describe('Which sections of each note to return.'),
      max_chars: z
        .number()
        .int()
        .min(2_000)
        .max(400_000)
        .default(120_000)
        .describe('Total character budget shared across all requested notes.')
    },
    annotations: { ...READ_ONLY, title: 'Get several notes' }
  },
  (args) => run(() => getNotesTool(lib(), args))
)

// ---------------------------------------------------------------------------
// Write tools (disabled by GRANOLA_MCP_READONLY=1)
// ---------------------------------------------------------------------------

const WRITE_SAFE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

if (WRITES_ENABLED) {
  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description:
        'Create a new note, optionally inside a folder and with initial Markdown content (headings, lists, bold/italic, code blocks all survive). The note opens in the app as an ordinary editable document. Use this to save research syntheses, reading notes, or follow-ups into the library so later sessions can build on them.',
      inputSchema: {
        title: z.string().min(1).describe('Title for the new note.'),
        folder: z
          .string()
          .optional()
          .describe('Folder to file it in, by name or id. Omit to leave it unfiled.'),
        content_markdown: z
          .string()
          .optional()
          .describe('Initial content as Markdown. Omit to create an empty note.')
      },
      annotations: { ...WRITE_SAFE, title: 'Create note' }
    },
    (args) => run(() => createNoteTool(lib(), args))
  )

  server.registerTool(
    'update_note',
    {
      title: 'Update note',
      description:
        'Change one note: append Markdown to its rough notes (the safe default for adding findings), replace the rough notes entirely, retitle it, or move it to a folder ("unfiled" removes it from its folder). Never touches the transcript or the AI-enhanced notes. Refuses while the note is being recorded.',
      inputSchema: {
        note_id: z.string().min(1).describe('Note id from a search or list result (a prefix works).'),
        title: z.string().optional().describe('New title.'),
        folder: z
          .string()
          .optional()
          .describe('Move to this folder (name or id); "unfiled" removes it from its folder.'),
        append_markdown: z
          .string()
          .optional()
          .describe('Markdown to append to the end of the rough notes.'),
        replace_markdown: z
          .string()
          .optional()
          .describe('Markdown that REPLACES the rough notes. Prefer append_markdown.')
      },
      annotations: { ...WRITE_SAFE, title: 'Update note' }
    },
    (args) => run(() => updateNoteTool(lib(), args))
  )

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a new folder. Folder names are unique (case-insensitive).',
      inputSchema: { name: z.string().min(1).describe('Name for the new folder.') },
      annotations: { ...WRITE_SAFE, title: 'Create folder' }
    },
    (args) => run(() => createFolderTool(lib(), args))
  )

  server.registerTool(
    'rename_folder',
    {
      title: 'Rename folder',
      description: 'Rename an existing folder.',
      inputSchema: {
        folder: z.string().min(1).describe('The folder to rename, by name or id.'),
        new_name: z.string().min(1).describe('The new name.')
      },
      annotations: { ...WRITE_SAFE, title: 'Rename folder' }
    },
    (args) => run(() => renameFolderTool(lib(), args))
  )

  server.registerTool(
    'start_recording',
    {
      title: 'Start recording',
      description:
        'Start recording a meeting NOW on this Mac (microphone + system audio, live transcription). Creates a titled note and begins capture — the app must be running, and one recording runs at a time. Use when the user asks to record, or when a meeting is starting that they want captured. Confirm the capture took with recording_status.',
      inputSchema: {
        title: z.string().optional().describe('Title for the meeting note.'),
        folder: z
          .string()
          .optional()
          .describe('Folder to file the note in, by name or id. Omit to leave it unfiled.')
      },
      annotations: { ...WRITE_SAFE, title: 'Start recording' }
    },
    (args) => runAsync(() => startRecordingTool(lib(), args))
  )

  server.registerTool(
    'stop_recording',
    {
      title: 'Stop recording',
      description:
        'Stop the current recording. The note keeps the full transcript and can then be enhanced in the app.',
      inputSchema: {},
      annotations: { ...WRITE_SAFE, title: 'Stop recording' }
    },
    () => runAsync(() => stopRecordingTool(lib()))
  )

  server.registerTool(
    'import_recording',
    {
      title: 'Import a recording',
      description:
        'Transcribe a local audio or video file (mp3, wav, m4a, flac, ogg, mp4, mov, webm, mkv…) into a new note, with speaker diarization. Requires the Granola Clone app to be RUNNING — transcription happens inside it with its Deepgram key. Returns immediately with the new note id; the transcript lands on the note when transcription finishes.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the audio/video file on this Mac.'),
        title: z.string().optional().describe('Title for the note. Defaults to the file name.'),
        folder: z
          .string()
          .optional()
          .describe('Folder to file the note in, by name or id. Omit to leave it unfiled.')
      },
      annotations: { ...WRITE_SAFE, title: 'Import a recording' }
    },
    (args) => runAsync(() => importRecordingTool(lib(), args))
  )

  server.registerTool(
    'export_note',
    {
      title: 'Export a note',
      description:
        'Export one note to a file: Markdown (with frontmatter), standalone HTML, PDF, or DOCX — full content including the transcript. Requires the app to be running. Give an absolute destination path.',
      inputSchema: {
        note_id: z.string().min(1).describe('Note id from a search or list result.'),
        format: z.enum(['md', 'html', 'pdf', 'docx']).describe('Output format.'),
        dest_path: z
          .string()
          .min(1)
          .describe('Absolute file path to write, e.g. /Users/me/Desktop/note.pdf')
      },
      annotations: { ...WRITE_SAFE, title: 'Export a note' }
    },
    (args) => runAsync(() => exportNoteTool(lib(), args))
  )

  server.registerTool(
    'export_library',
    {
      title: 'Export the library',
      description:
        'Export the whole library (or one folder) as an Obsidian vault — Markdown notes with [[wikilinks]] and Concepts/ stub pages, so Obsidian renders the same knowledge graph — or as one machine-readable JSON bundle (notes, transcripts, concepts, relations; doubles as a backup). Requires the app to be running.',
      inputSchema: {
        format: z
          .enum(['obsidian_vault', 'json'])
          .describe('"obsidian_vault" writes a directory of Markdown; "json" writes one file.'),
        dest_path: z
          .string()
          .min(1)
          .describe('Absolute destination: a directory for obsidian_vault, a .json file path for json.'),
        folder: z.string().optional().describe('Limit to one folder, by name or id.')
      },
      annotations: { ...WRITE_SAFE, title: 'Export the library' }
    },
    (args) => runAsync(() => exportLibraryTool(lib(), args))
  )

  server.registerTool(
    'export_to_notion',
    {
      title: 'Export to Notion',
      description:
        "Export one note, one folder, or the whole library to the user's Notion workspace (their integration token and parent page are set in the app's Settings). Notes become pages with full formatting. Returns the Notion URL. Requires the app to be running.",
      inputSchema: {
        note_id: z.string().optional().describe('Export just this note.'),
        folder: z
          .string()
          .optional()
          .describe('Export this folder. Omit both arguments to export the whole library.')
      },
      annotations: { ...WRITE_SAFE, title: 'Export to Notion' }
    },
    (args) => runAsync(() => exportNotionTool(lib(), args))
  )

  server.registerTool(
    'delete_note',
    {
      title: 'Delete note',
      description:
        'PERMANENTLY delete a note with its transcript and chat thread. Two-step: called without confirm it only reports what would be lost and returns a confirmation token; call again with that token to actually delete. Only delete when the user asked for it.',
      inputSchema: {
        note_id: z.string().min(1).describe('Note id from a search or list result.'),
        confirm: z
          .string()
          .optional()
          .describe('The confirmation token returned by the first call.')
      },
      annotations: { ...WRITE_DESTRUCTIVE, title: 'Delete note' }
    },
    (args) => run(() => deleteNoteTool(lib(), args))
  )

  server.registerTool(
    'delete_folder',
    {
      title: 'Delete folder',
      description:
        'Delete a folder and its chat thread. The notes inside are NOT deleted — they become unfiled. Two-step like delete_note: first call returns a confirmation token, second call with the token deletes. Only delete when the user asked for it.',
      inputSchema: {
        folder: z.string().min(1).describe('The folder to delete, by name or id.'),
        confirm: z
          .string()
          .optional()
          .describe('The confirmation token returned by the first call.')
      },
      annotations: { ...WRITE_DESTRUCTIVE, title: 'Delete folder' }
    },
    (args) => run(() => deleteFolderTool(lib(), args))
  )
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function shutdown(): void {
  try {
    library?.db.close()
  } catch {
    // closing a read-only handle on the way out is best-effort
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
console.error('notetaker: MCP server ready on stdio')
