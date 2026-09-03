// Import an audio/video file as a note: Deepgram pre-recorded transcription
// with the same model family and diarization the live recorder uses, landing
// in the same tables — so an imported lecture is indistinguishable from a
// recorded one to search, chat, enhancement, and MCP.
//
// The note is created immediately (status 'draft', titled after the file) and
// transcription runs as a background job; 'status' events drive the UI and a
// final library-changed broadcast refreshes everything. A crash mid-import
// leaves an honest draft with no transcript — re-import is safe.
import { EventEmitter } from 'events'
import { createReadStream, existsSync, statSync } from 'fs'
import { basename, extname } from 'path'
import type { ImportStatus } from '@shared/types'
import { getDeepgramKey } from '../settings'
import { createMeeting, setEnded, setStarted, updateTitle } from '../db/meetings'
import { setMeetingFolder } from '../db/folders'
import { insertSegment } from '../db/transcripts'
import { reindexMeeting } from '../db/search'
import { withTransaction } from '../db/database'

/** Containers Deepgram's pre-recorded endpoint decodes. Video is fine — it
 *  reads the audio track. */
export const IMPORTABLE_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'mkv'
]

const MAX_FILE_BYTES = 1_500 * 1024 * 1024 // Deepgram's direct-upload cap is 2GB
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000

const DEEPGRAM_LISTEN = 'https://api.deepgram.com/v1/listen'

interface DeepgramUtterance {
  start: number
  end: number
  transcript: string
  speaker?: number
}

interface DeepgramPrerecorded {
  metadata?: { duration?: number }
  results?: {
    utterances?: DeepgramUtterance[]
    channels?: { alternatives?: { transcript?: string }[] }[]
  }
}

class Importer extends EventEmitter {
  /** Serial queue: parallel uploads of two lecture videos would contend for
   *  bandwidth and Deepgram throughput without finishing any sooner. */
  private queue: Promise<void> = Promise.resolve()
  private active = new Set<string>()

  isImporting(meetingId: string): boolean {
    return this.active.has(meetingId)
  }

  /** Validate + create the note now; transcribe in the background. Throws only
   *  for immediately-diagnosable problems (bad path, no key). */
  start(args: { filePath: string; title?: string; folderId?: string | null }): {
    meetingId: string
  } {
    const { filePath } = args
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
    const ext = extname(filePath).slice(1).toLowerCase()
    if (!IMPORTABLE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `.${ext || '?'} is not an importable format. Supported: ${IMPORTABLE_EXTENSIONS.join(', ')}`
      )
    }
    const { size } = statSync(filePath)
    if (size === 0) throw new Error('The file is empty.')
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        `The file is ${Math.round(size / 1024 / 1024)} MB; the import cap is ${Math.round(
          MAX_FILE_BYTES / 1024 / 1024
        )} MB.`
      )
    }
    const apiKey = getDeepgramKey()
    if (!apiKey) {
      throw new Error('No Deepgram API key is set — add one in Settings to transcribe imports.')
    }

    const meeting = createMeeting()
    const title = args.title?.trim() || basename(filePath, extname(filePath))
    updateTitle(meeting.id, title)
    if (args.folderId) setMeetingFolder(meeting.id, args.folderId)

    this.active.add(meeting.id)
    this.emitStatus({ meetingId: meeting.id, state: 'transcribing' })
    this.queue = this.queue.then(() =>
      this.transcribe(meeting.id, filePath, size, apiKey).catch((err) => {
        // transcribe reports its own failures; this catch only keeps the
        // queue chain alive.
        console.error('import: job failed', err)
      })
    )
    return { meetingId: meeting.id }
  }

  private emitStatus(status: ImportStatus): void {
    this.emit('status', status)
  }

  /** One upload attempt. Separated so the diarizer-version fallback below can
   *  retry the whole request with different parameters — a Response body can
   *  only be read once, so the retry needs a fresh request, not a re-read. */
  private async post(
    filePath: string,
    size: number,
    apiKey: string,
    params: URLSearchParams
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
    try {
      return await fetch(`${DEEPGRAM_LISTEN}?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size)
        },
        body: createReadStream(filePath),
        // Node fetch requires this for a streamed request body.
        duplex: 'half',
        signal: controller.signal
      } as RequestInit)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async transcribe(
    meetingId: string,
    filePath: string,
    size: number,
    apiKey: string
  ): Promise<void> {
    const startedAt = Date.now()
    try {
      // diarize_model selects the v2 batch diarizer; the plain `diarize=true`
      // this used to send is deprecated and routes to v1. The two are mutually
      // exclusive — sending both is rejected — so this is a replace, not an
      // add. Batch-only: the parameter is not accepted on streaming requests,
      // which is why the live sockets stay on v1 (deepgramSession.ts).
      // utt_split raises the pause that ends an utterance from 0.8s to 1.5s, so
      // a lecturer pausing to write on the board stops fragmenting one
      // explanation into a dozen utterances — each a fresh chance for the
      // diarizer to flip the speaker label.
      const params = new URLSearchParams({
        model: 'nova-3',
        smart_format: 'true',
        punctuate: 'true',
        diarize_model: 'latest',
        utt_split: '1.5',
        utterances: 'true'
      })
      let response = await this.post(filePath, size, apiKey, params)
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        // An account or region that does not know diarize_model must still be
        // able to import: fall back once to the legacy parameters rather than
        // failing the whole job over a quality flag.
        if (response.status === 400 && detail.includes('diarize_model')) {
          console.warn('import: diarize_model rejected, retrying with legacy diarize=true')
          const legacy = new URLSearchParams({
            model: 'nova-3',
            smart_format: 'true',
            punctuate: 'true',
            diarize: 'true',
            utterances: 'true'
          })
          response = await this.post(filePath, size, apiKey, legacy)
          if (!response.ok) {
            const retryDetail = (await response.text()).slice(0, 300)
            throw new Error(`Deepgram error ${response.status}: ${retryDetail}`)
          }
        } else {
          throw new Error(`Deepgram error ${response.status}: ${detail}`)
        }
      }
      const json = (await response.json()) as DeepgramPrerecorded
      const utterances = json.results?.utterances ?? []

      // Everything imported is 'system' channel: the mic convention ("Me")
      // only applies to live capture. An imported file has no note-taker voice
      // at all — nothing in it identifies which speaker holds the phone — so
      // its roster gets no "Me" and every voice lands as Speaker 1, 2, …,
      // renameable exactly like a live recording's (db/speakers.ts).
      withTransaction(() => {
        for (const u of utterances) {
          const text = u.transcript.trim()
          if (!text) continue
          insertSegment(
            meetingId,
            'system',
            text,
            Math.round(u.start * 1000),
            Math.round(u.end * 1000),
            u.speaker ?? null
          )
        }
        const durationMs = Math.round((json.metadata?.duration ?? 0) * 1000)
        setStarted(meetingId, startedAt)
        setEnded(meetingId, startedAt + durationMs)
        reindexMeeting(meetingId)
      })
      this.active.delete(meetingId)
      this.emitStatus({
        meetingId,
        state: 'done',
        message:
          utterances.length === 0
            ? 'No speech detected in the recording.'
            : `${utterances.length} transcript lines`
      })
    } catch (err) {
      this.active.delete(meetingId)
      const message = err instanceof Error ? err.message : String(err)
      console.error('import: transcription failed', message)
      this.emitStatus({ meetingId, state: 'error', message })
    }
  }
}

export const importer = new Importer()
