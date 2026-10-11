import { readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import type { CraftAgentControl } from '../../shared/types.ts'
import { recordOf, stringOf } from '../json.ts'
import type { CraftAdapter } from './craft-adapters.ts'

// The host's connections to the Craft apps' own control channels: loopback TCP, one JSON request
// per line (JSON-RPC 2.0 for PdfCraft). Talking to the app directly, rather than through its CLI's
// `mcp --bridge` server, costs no extra process and works for PdfCraft, which has no bridge.
//
// One connection per running app, kept between calls, and one call at a time per app: two models
// never interleave commands in one document. A connection the app closed (PhotoCraft drops an
// authenticated connection after 30 s idle, checked on 0.7.0) is opened again before the next
// call, and a request lost to such a close is sent once more on a fresh connection.

/** A full sentence the tool hands to the model as it is. */
export class CraftError extends Error {}

export type Reply = { ok: true; result: unknown } | { ok: false; error: string }

/** Reads the files an app's credentials are in; injected so tests need no disk. */
export type CredentialReader = (path: string) => Promise<string>

const MAX_REPLY = 64 * 1024 * 1024
/** A close this soon after a request was sent is taken for an idle close that raced it. */
const RACE_MS = 2_000
/** How long a starting app has to open its control channel, and how often it is tried meanwhile. */
const CONNECT_MS = 15_000
const RETRY_MS = 150

type Pending = { id: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; sentAt: number }

/** One open connection to one launch of one app. */
export class CraftConnection {
  private socket: Socket | null = null
  private opening: Promise<void> | null = null
  private buffer = ''
  private seq = 0
  private pending: Pending | null = null
  private lastUse = 0
  /** How often a lost request was sent again; for the tests and the journal. */
  reconnects = 0

  constructor(
    private readonly adapter: CraftAdapter,
    private readonly control: CraftAgentControl,
    private readonly name: string,
    private readonly read: CredentialReader = (path) => readFile(path, 'utf8'),
    private readonly now: () => number = Date.now
  ) {}

  get launch(): number {
    return this.control.launch
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }

  /** One request and its reply. A timeout leaves the connection open; a late reply is dropped. */
  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const idle = this.adapter.idleCloseMs
    // The app is about to drop (or has dropped) an idle connection: start a fresh one rather than race it.
    if (this.socket && idle !== null && this.now() - this.lastUse > idle - 5_000) this.close()
    try {
      return await this.send(method, params, timeoutMs)
    } catch (error) {
      if (!(error instanceof LostRequest)) throw error
      this.reconnects++
      return await this.send(method, params, timeoutMs)
    }
  }

  private async send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    await this.open(timeoutMs)
    const id = ++this.seq
    const socket = this.socket!
    return await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) this.pending = null
        reject(new CraftError(`${this.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds. It may still be working: call craft_inspect to see where it is before running the command again.`))
      }, timeoutMs)
      timer.unref?.()
      this.pending = {
        id,
        sentAt: this.now(),
        resolve: (reply) => { clearTimeout(timer); resolve(reply) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      }
      this.lastUse = this.now()
      socket.write(`${JSON.stringify(this.frame(id, method, params))}\n`)
    })
  }

  private frame(id: number, method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (this.adapter.framing === 'jsonrpc') return { jsonrpc: '2.0', id, method, params }
    return { id, method, params }
  }

  private async open(timeoutMs: number): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    this.opening ??= this.connect(Math.min(timeoutMs, CONNECT_MS)).finally(() => { this.opening = null })
    await this.opening
  }

  /**
   * A just-started app's window is docked within milliseconds, well before it listens (GridCraft
   * 0.5.0: refused at 30 ms after the dock caught its window), and PdfCraft and WordCraft write
   * their control and key files only once they listen. So a refused or not-yet-written channel is
   * tried again until the deadline.
   */
  private async connect(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let socket: Socket
    let where: { port: number; secret: string | null }
    for (;;) {
      try {
        where = await this.address()
        socket = await this.dial(where.port, Math.max(1_000, deadline - Date.now()))
        break
      } catch (error) {
        if (!(error instanceof NotYet) || Date.now() + RETRY_MS >= deadline) throw error instanceof NotYet ? new CraftError(error.message) : error
        await new Promise((wait) => setTimeout(wait, RETRY_MS))
      }
    }
    this.socket = socket
    this.buffer = ''
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', () => {})
    socket.on('close', () => this.onClose(socket))
    this.lastUse = this.now()
    const auth = this.authFrame(where.secret)
    if (auth) {
      const id = ++this.seq
      const reply = await new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CraftError(`${this.name} did not answer its sign-in within ${Math.round(timeoutMs / 1000)} seconds. Try again in a moment.`)), timeoutMs)
        this.pending = { id, sentAt: this.now(), resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } }
        socket.write(`${JSON.stringify({ ...auth, id })}\n`)
      }).catch((error: unknown) => {
        // The sign-in itself was lost: that is a refusal, not an idle close to retry.
        this.close()
        throw error instanceof LostRequest ? new CraftError(`${this.name} closed the connection at sign-in. It may have been restarted: try again.`) : error
      })
      if (!reply.ok) {
        this.close()
        throw new CraftError(`${this.name} refused Craft Studio's sign-in (${reply.error}). It may have been restarted outside Craft Studio; ask the user to close it and open it again from the dock.`)
      }
    }
  }

  private dial(port: number, timeoutMs: number): Promise<Socket> {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new CraftError(`${this.name} did not accept a connection within ${Math.round(timeoutMs / 1000)} seconds. Try again in a moment; if it keeps happening, the app may have hung: ask the user to look at it.`)) }, timeoutMs)
      socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        socket.destroy()
        const message = `${this.name} refused the connection (${error.message}). It may have quit: call craft_apps, and if it is not running ask the user to open it from the dock.`
        reject(error.code === 'ECONNREFUSED' ? new NotYet(message) : new CraftError(message))
      })
    })
  }

  /** The port, and the token or key, for this launch. */
  private async address(): Promise<{ port: number; secret: string | null }> {
    const { control } = this
    const auth = this.adapter.auth
    if (control.controlFile) {
      // PdfCraft binds its own port and writes `{port, token, pid}` once it listens.
      const text = await this.read(control.controlFile).catch(() => '')
      let parsed: Record<string, unknown> = {}
      try { parsed = recordOf(JSON.parse(text)) } catch { /* not written yet */ }
      const port = Number(parsed.port)
      if (!Number.isInteger(port) || port <= 0) throw new NotYet(`${this.name} has not opened its control channel yet. Try again in a few seconds.`)
      return { port, secret: stringOf(parsed.token) || null }
    }
    if (!control.port) throw new CraftError(`${this.name} has no control port. Ask the user to close it and open it again from the dock.`)
    if (auth.kind === 'token') {
      if (!control.tokenFile) throw new CraftError(`${this.name} was started without its control token. Ask the user to close it and open it again from the dock.`)
      return { port: control.port, secret: (await this.read(control.tokenFile)).trim() }
    }
    if (auth.kind === 'key') {
      const file = join(control.configHome, auth.path.replaceAll('{port}', String(control.port)))
      const key = (await this.read(file).catch(() => '')).trim()
      if (!key) throw new NotYet(`${this.name} has not written its control key yet. Try again in a few seconds.`)
      return { port: control.port, secret: key }
    }
    return { port: control.port, secret: null }
  }

  private authFrame(secret: string | null): Record<string, unknown> | null {
    const auth = this.adapter.auth
    if (auth.kind === 'none' || !secret) return null
    if (this.adapter.framing === 'jsonrpc') return { jsonrpc: '2.0', method: auth.method, params: { [auth.field]: secret } }
    if (auth.kind === 'key') return { method: auth.method, [auth.field]: secret }
    return { method: auth.method, params: { [auth.field]: secret } }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_REPLY) {
      this.pending?.reject(new CraftError(`${this.name} sent a reply over ${MAX_REPLY / 1024 / 1024} MB. Ask for less, e.g. a smaller range or a search.`))
      this.pending = null
      this.close()
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try { message = recordOf(JSON.parse(line)) } catch { return }
    const pending = this.pending
    // A reply for a request that timed out earlier is dropped. Some apps answer a refused line
    // without an id, so an id-less error goes to whoever is waiting.
    if (!pending || (message.id !== undefined && message.id !== null && message.id !== pending.id)) return
    this.pending = null
    this.lastUse = this.now()
    pending.resolve(replyOf(message))
  }

  private onClose(socket: Socket): void {
    if (this.socket === socket) this.socket = null
    const pending = this.pending
    if (!pending) return
    this.pending = null
    if (this.now() - pending.sentAt <= RACE_MS) pending.reject(new LostRequest())
    else pending.reject(new CraftError(`${this.name} closed the connection while working on the request. It may have quit or restarted: call craft_apps, then craft_inspect, before trying again.`))
  }
}

/** The request went out just as the app closed the connection: it is sent once more. */
class LostRequest extends Error {}

/** The app is not listening yet (or has not written where it listens): tried again until the deadline. */
class NotYet extends Error {}

/** Both reply shapes as one: `{ok, result | error}` lines and JSON-RPC 2.0. */
export function replyOf(message: Record<string, unknown>): Reply {
  if (message.ok === false) return { ok: false, error: errorText(message.error) }
  if (message.ok === true) return { ok: true, result: message.result ?? null }
  if (message.error !== undefined && message.error !== null) return { ok: false, error: errorText(message.error) }
  return { ok: true, result: message.result ?? null }
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const record = recordOf(error)
  return stringOf(record.message) || JSON.stringify(error) || 'the app refused the request without saying why'
}

/** One call at a time per app, in arrival order. */
export class CraftQueue {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly busy = new Map<string, number>()

  run<T>(app: string, work: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(app) ?? Promise.resolve()
    this.busy.set(app, (this.busy.get(app) ?? 0) + 1)
    const next = tail.then(work, work).finally(() => {
      const left = (this.busy.get(app) ?? 1) - 1
      if (left) this.busy.set(app, left)
      else this.busy.delete(app)
    })
    this.tails.set(app, next.catch(() => {}))
    return next
  }

  /** Whether a call to this app is running or waiting. */
  isBusy(app: string): boolean {
    return (this.busy.get(app) ?? 0) > 0
  }
}

/** The open connections, one per app, replaced when the app's launch changes. */
export class CraftConnections {
  private readonly open = new Map<string, CraftConnection>()

  constructor(private readonly make: (adapter: CraftAdapter, control: CraftAgentControl, name: string) => CraftConnection) {}

  get(adapter: CraftAdapter, control: CraftAgentControl, name: string): CraftConnection {
    const current = this.open.get(control.app)
    if (current && current.launch === control.launch) return current
    current?.close()
    const fresh = this.make(adapter, control, name)
    this.open.set(control.app, fresh)
    return fresh
  }

  closeAll(): void {
    for (const connection of this.open.values()) connection.close()
    this.open.clear()
  }
}
