// Request/response client for the app's control socket (src/main/control.ts).
//
// Some agent actions can only run inside the app — transcribing an import
// needs the Deepgram key, recording needs the audio stack — so those tools
// hand the request to a running app over the local socket. Distinct from
// writes.ts notifyApp, which is fire-and-forget by design.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import type { Library } from './db.ts'

/** Generous: stop-recording waits for transcript sessions to flush. */
const REQUEST_TIMEOUT_MS = 20_000

export interface AppResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export class AppNotRunningError extends Error {
  constructor() {
    super(
      'The Granola Clone app is not running. Launch it first — this action runs inside the app (it needs the API keys and audio stack the MCP server deliberately has no access to).'
    )
  }
}

/** One op over the socket. Throws AppNotRunningError when no app is listening,
 *  or a plain Error relaying the app's failure text. */
export function appRequest(
  lib: Library,
  op: string,
  args: Record<string, unknown>
): Promise<AppResponse> {
  const dir = dirname(lib.path)
  let token: string
  try {
    token = readFileSync(join(dir, 'control.token'), 'utf8').trim()
  } catch {
    throw new AppNotRunningError()
  }
  if (!token) throw new AppNotRunningError()

  return new Promise<AppResponse>((resolve, reject) => {
    const socket = connect(join(dir, 'control.sock'))
    let buffer = ''
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('The app did not answer in time.')), REQUEST_TIMEOUT_MS)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, op, args })}\n`)
    })
    socket.on('data', (data) => {
      buffer += data.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      if (settled) return
      settled = true
      socket.destroy()
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as AppResponse
        if (!response.ok) {
          reject(new Error(response.error ?? 'The app rejected the request.'))
          return
        }
        resolve(response)
      } catch {
        reject(new Error('The app sent an unreadable response.'))
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      fail(new AppNotRunningError())
    })
    socket.on('close', () => {
      clearTimeout(timer)
      fail(new Error('The app closed the connection before answering.'))
    })
  })
}
