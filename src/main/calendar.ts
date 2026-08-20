// Calendar-triggered auto-recording.
//
// Polls the calendarpeek helper (EventKit, one-shot, JSON out) and, when a
// meeting-shaped event reaches its start, creates a titled note and asks the
// renderer to start recording it — the same start path the user's own Record
// button takes, so mic permission and capture behave identically.
//
// "Meeting-shaped": has other attendees or carries a meeting link. A timed
// event with neither ("Dentist") is left alone. The whole feature sits behind
// the calendarAutoRecord setting, off by default — the first poll is also
// what triggers the macOS calendar-access prompt, so it must be user-initiated.
import { spawn } from 'child_process'
import { Notification, app } from 'electron'
import { helperPath } from './audio/helperPath'
import { getCalendarAutoRecord } from './settings'
import { withTransaction } from './db/database'
import { createMeeting, updateTitle } from './db/meetings'
import { reindexMeeting } from './db/search'
import { recorder } from './transcription/recorder'
import { broadcast, requestRecordingStart } from './ipc'

const POLL_MS = 60_000
/** Start this early so the opening remarks are on the transcript. */
const LEAD_MS = 60_000
/** Don't barge into a meeting that is already mostly over. */
const LATE_JOIN_MS = 10 * 60_000

export interface CalendarEvent {
  id: string
  title: string
  startMs: number
  endMs: number
  calendar: string
  attendees: number
  hasMeetingLink: boolean
}

export type CalendarAccess = 'granted' | 'denied' | 'error'

let timer: NodeJS.Timeout | null = null
/** Events already acted on (or deliberately skipped), so one event never
 *  starts two recordings. Pruned as events age out. */
const handled = new Map<string, number>()
let lastAccess: CalendarAccess | null = null

/** One helper run. Resolves with the events, 'denied', or 'error' — never
 *  rejects: the watcher must survive a broken helper. */
export function peekCalendar(hours: number): Promise<CalendarEvent[] | 'denied' | 'error'> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (value: CalendarEvent[] | 'denied' | 'error'): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(helperPath('calendarpeek'), ['--hours', String(hours)], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      done('error')
      return
    }
    // The helper itself waits up to 60 s for the TCC prompt; give it that
    // plus slack, then give up on this poll.
    const bail = setTimeout(() => {
      child.kill()
      done('error')
    }, 70_000)
    child.on('error', () => {
      clearTimeout(bail)
      done('error')
    })
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8')
    })
    child.on('exit', (code) => {
      clearTimeout(bail)
      if (code === 2) {
        done('denied')
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown
        if (Array.isArray(parsed)) {
          done(
            parsed.filter(
              (e): e is CalendarEvent =>
                !!e &&
                typeof (e as CalendarEvent).startMs === 'number' &&
                typeof (e as CalendarEvent).endMs === 'number'
            )
          )
          return
        }
        done('error')
      } catch {
        done('error')
      }
    })
  })
}

/** Result of the last poll's access check, for the Settings surface. */
export function calendarAccess(): CalendarAccess | null {
  return lastAccess
}

function meetingShaped(e: CalendarEvent): boolean {
  return e.hasMeetingLink || e.attendees >= 2
}

function notify(title: string, body: string): void {
  // Notifications are dropped for ad-hoc-signed builds; the dock bounce is the
  // reliable part of the pair.
  app.dock?.bounce('informational')
  if (!Notification.isSupported()) return
  new Notification({ title, body, silent: true }).show()
}

async function tick(): Promise<void> {
  if (!getCalendarAutoRecord()) return
  const result = await peekCalendar(1)
  if (result === 'denied' || result === 'error') {
    if (result !== lastAccess) {
      console.warn(`calendar: access ${result}`)
      if (result === 'denied') {
        notify(
          'Calendar access needed',
          'Auto-record is on but calendar access is denied. Allow it in System Settings → Privacy & Security → Calendars.'
        )
      }
    }
    lastAccess = result
    return
  }
  lastAccess = 'granted'

  const now = Date.now()
  for (const [key, endMs] of handled) {
    if (endMs < now - 3_600_000) handled.delete(key)
  }

  for (const event of result) {
    const key = `${event.id}:${event.startMs}`
    if (handled.has(key)) continue
    if (now < event.startMs - LEAD_MS) continue
    if (now > Math.min(event.endMs, event.startMs + LATE_JOIN_MS)) continue
    handled.set(key, event.endMs)
    if (!meetingShaped(event)) continue
    if (recorder.currentState !== 'idle') {
      console.log(`calendar: skipping "${event.title}" — already recording`)
      continue
    }

    const meeting = createMeeting()
    withTransaction(() => {
      updateTitle(meeting.id, event.title || 'Calendar meeting')
      reindexMeeting(meeting.id)
    })
    broadcast('library:changed', { noteIds: [meeting.id], folders: false })
    console.log(`calendar: auto-recording "${event.title}"`)
    notify('Recording started', `"${event.title}" is on your calendar — taking notes now.`)
    await requestRecordingStart(meeting.id)
  }
}

export function startCalendarWatcher(): void {
  if (timer) return
  timer = setInterval(() => void tick(), POLL_MS)
  // First poll now — also what surfaces the TCC prompt right after the user
  // turns the setting on.
  void tick()
}

/** Poll immediately — called when the user flips auto-record on so the
 *  calendar permission prompt appears right away, not a minute later. */
export function pollCalendarNow(): void {
  void tick()
}

export function stopCalendarWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}
