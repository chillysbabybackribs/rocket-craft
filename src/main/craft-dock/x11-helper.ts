import { readFileSync } from 'node:fs'
import x11, { type XClient, type XEvent, type XExtension } from 'x11'
import type { HelperEvent, HelperReply, HelperRequest, DeviceRect } from './protocol.ts'

// The dock's X11 hands, in a process of their own. Main forks it as a utility process and talks to
// it in the messages of `protocol.ts`; run with plain Node it reads the same messages as JSON lines
// on stdin, which is how the X11 checks drive it on a private display.
//
// Why a separate process: the focus guard holds a synchronous button grab, which freezes the
// pointer for the whole X server until this client answers. Electron's main process can be busy
// for tens of milliseconds at a time; this process does nothing else. Its X connection also owns
// the Composite redirects and the shields, so they live exactly as long as the dock does.
//
// Why pure Node (the `x11` package): production needs nothing beyond what ships in node_modules.
// The spike's python-xlib helper needed a Python package that is not on a stock system.
//
// What it does, all proven in spikes/native-dock (openbox, no WM, and mutter live):
// - Catch: the root is watched for CreateNotify. The X-Resource extension names the process that
//   created a window before the app sets _NET_WM_PID. If it is the launched app (or a process it
//   started), the server is grabbed, the window is made override-redirect and reparented into
//   Electron's window, out of view. The app maps it later inside Electron, so the window manager
//   never sees it: no flash, no taskbar entry, no stolen focus. A window that was managed anyway
//   is withdrawn and reparented only after the WM has handed it back to the root (mutter can take
//   over a second; reparenting earlier lets it move the window back later).
// - Park: a hidden app is moved out of the parent's bounds and stays mapped. A window the server
//   reports as fully obscured stops drawing, which makes the app's screenshots hang, so a parked
//   app that may be called is Composite-redirected (it keeps its own pixmap and keeps drawing).
// - Focus guard: X sends keys to the window under the pointer when that window is inside the focus
//   window, so with the chat focused and the pointer over a docked app the app would get (and
//   drop) the chat's keys. Each app gets an InputOnly "shield" child on which only this client
//   selects keys; keys landing there are forwarded to Electron. A press on the shield focuses the
//   app and is replayed to it. When the WM re-focuses Electron after a click into the app, the
//   FocusIn is answered by focusing the app again. A press on Electron's own page arrives from the
//   renderer as `wantElectron`.
//
// Every per-window record is keyed by launch, never by XID: a relaunched app can get the very same
// XID as the one that just closed.

type Transport = { send: (message: HelperReply | HelperEvent) => void; onMessage: (listener: (message: HelperRequest) => void) => void }

const KeyPress = 0x1
const KeyRelease = 0x2
const ButtonPress = 0x4
const StructureNotify = 0x20000
const SubstructureNotify = 0x80000
const SubstructureRedirect = 0x100000
const FocusChange = 0x200000
const InputOnly = 2
const RevertToParent = 2
const ReplayPointer = 2
const GrabModeSync = 0
const GrabModeAsync = 1
const AnyModifier = 0x8000
const StackAbove = 0
const IsUnmapped = 0
const Composite = { Automatic: 0 }
const LocalClientPID = 2

type Launch = {
  launch: number
  pid: number
  unit: string | null
  wid: number | null
  shield: number | null
  redirected: boolean
  rect: DeviceRect | null
  shown: boolean
  /** Set once the window is ours; a second big top-level from the same app is left alone. */
  caught: boolean
  catching: boolean
}

export class X11Dock {
  private readonly X: XClient
  private readonly root: number
  private readonly composite: XExtension | null
  private readonly res: XExtension | null
  private electron = 0
  private readonly launches = new Map<number, Launch>()
  private want: 'electron' | 'app' = 'electron'
  private shownLaunch: number | null = null
  private readonly atoms = new Map<string, number>()

  constructor(X: XClient, root: number, composite: XExtension | null, res: XExtension | null, private readonly emit: (event: HelperEvent) => void) {
    this.X = X
    this.root = root
    this.composite = composite
    this.res = res
    X.on('event', (event) => { void this.onEvent(event).catch((error: unknown) => this.log('event failed', error)) })
    // Requests without a callback fail here: almost always a window that has just gone away.
    X.on('error', (error) => this.log('x error', error))
  }

  static async connect(emit: (event: HelperEvent) => void, display?: string): Promise<X11Dock> {
    const { X, root } = await new Promise<{ X: XClient; root: number }>((done, fail) => {
      x11.createClient(display ? { display } : {}, (error, d) => error ? fail(error) : done({ X: d.client, root: d.screen[0]!.root }))
    })
    const ext = (name: string): Promise<XExtension | null> => new Promise((done) => X.require(name, (error, value) => { done(error ? null : value); return true }))
    return new X11Dock(X, root, await ext('composite'), await ext('res'), emit)
  }

  async handle(request: HelperRequest): Promise<unknown> {
    switch (request.op) {
      case 'init': return this.init(request.electron)
      case 'expect': return this.expect(request.launch, request.pid, request.unit)
      case 'forget': return this.forget(request.launch)
      case 'show': return this.show(request.launch, request.rect)
      case 'park': return this.park(request.launch, request.rect, request.redirect)
      case 'redirect': return this.setRedirect(request.launch, request.on)
      case 'wantElectron': return this.wantElectron()
      case 'state': return this.state()
    }
  }

  private async init(electron: number): Promise<unknown> {
    this.electron = electron
    // Root: every new top-level. Electron: focus changes, for the guard.
    this.X.ChangeWindowAttributes(this.root, { eventMask: SubstructureNotify })
    this.X.ChangeWindowAttributes(electron, { eventMask: FocusChange })
    await this.X.sync()
    return { composite: !!this.composite, xres: !!this.res }
  }

  private async expect(launch: number, pid: number, unit: string | null): Promise<unknown> {
    this.launches.set(launch, { launch, pid, unit, wid: null, shield: null, redirected: false, rect: null, shown: false, caught: false, catching: false })
    // The window may already exist if the app was quick (or this helper restarted): look now.
    for (const wid of (await this.call<{ children: number[] }>((cb) => this.X.QueryTree(this.root, cb))).children) {
      const owner = await this.ownerOf(wid)
      if (owner !== null && belongs(owner, pid, unit)) await this.consider(wid, owner, false)
    }
    return { ok: true }
  }

  private async forget(launch: number): Promise<unknown> {
    const record = this.launches.get(launch)
    this.launches.delete(launch)
    if (this.shownLaunch === launch) this.shownLaunch = null
    if (record?.shield) this.X.DestroyWindow(record.shield)
    await this.X.sync()
    return { ok: true }
  }

  private async show(launch: number, rect: DeviceRect): Promise<unknown> {
    const record = this.need(launch)
    record.rect = rect
    record.shown = true
    // Another app shown in the same place would cover it; the dock parks it first, but be sure.
    for (const other of this.launches.values()) {
      if (other !== record && other.shown && other.wid) await this.park(other.launch, rect, true)
    }
    this.shownLaunch = launch
    if (record.redirected) this.unredirect(record)
    this.X.ConfigureWindow(record.wid!, { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height), stackMode: StackAbove })
    this.X.MapWindow(record.wid!)
    if (record.shield) {
      this.X.ConfigureWindow(record.shield, { x: 0, y: 0, width: Math.max(1, rect.width), height: Math.max(1, rect.height), stackMode: StackAbove })
      if (this.want === 'electron') this.X.MapWindow(record.shield)
      else this.X.UnmapWindow(record.shield)
    }
    await this.X.sync()
    return { want: this.want }
  }

  private async park(launch: number, rect: DeviceRect | null, redirect: boolean): Promise<unknown> {
    const record = this.need(launch)
    const width = rect?.width ?? record.rect?.width ?? 800
    if (redirect) this.redirect(record)
    else if (record.redirected) this.unredirect(record)
    // Out of the parent's bounds and still mapped: clipped away, never unmapped.
    this.X.ConfigureWindow(record.wid!, { x: -(width + 200), y: 0 })
    record.shown = false
    if (this.shownLaunch === launch) {
      this.shownLaunch = null
      // The keyboard must not stay with a window nobody can see.
      if (this.want === 'app') {
        this.want = 'electron'
        this.X.SetInputFocus(this.electron, RevertToParent)
      }
    }
    await this.X.sync()
    return { ok: true }
  }

  private async setRedirect(launch: number, on: boolean): Promise<unknown> {
    const record = this.need(launch)
    if (record.shown) return { redirected: record.redirected }
    if (on) this.redirect(record)
    else this.unredirect(record)
    await this.X.sync()
    return { redirected: record.redirected }
  }

  private async wantElectron(): Promise<unknown> {
    this.want = 'electron'
    if (this.electron) this.X.SetInputFocus(this.electron, RevertToParent)
    const shown = this.shownLaunch === null ? null : this.launches.get(this.shownLaunch)
    if (shown?.shield) {
      this.X.ConfigureWindow(shown.shield, { stackMode: StackAbove })
      this.X.MapWindow(shown.shield)
    }
    await this.X.sync()
    return { ok: true }
  }

  private state(): unknown {
    return {
      want: this.want,
      shown: this.shownLaunch,
      launches: [...this.launches.values()].map(({ launch, pid, wid, shield, redirected, shown }) => ({ launch, pid, wid, shield, redirected, shown }))
    }
  }

  private need(launch: number): Launch & { wid: number } {
    const record = this.launches.get(launch)
    if (!record?.wid) throw new Error(`The app's window (launch ${launch}) is not docked.`)
    return record as Launch & { wid: number }
  }

  private redirect(record: Launch): void {
    if (record.redirected || !this.composite || !record.wid) return
    this.composite.RedirectWindow(record.wid, Composite.Automatic)
    record.redirected = true
  }

  private unredirect(record: Launch): void {
    if (!record.redirected || !this.composite || !record.wid) return
    // node-x11 4.3.1 sends CompositeUnredirectWindow without its update byte (length 2, not 3),
    // which the server rejects with BadLength, so the request is written here.
    const ext = this.composite as XExtension & { majorOpcode: number }
    const packet = Buffer.alloc(12)
    packet.writeUInt8(ext.majorOpcode, 0)
    packet.writeUInt8(3, 1)
    packet.writeUInt16LE(3, 2)
    packet.writeUInt32LE(record.wid >>> 0, 4)
    packet.writeUInt8(Composite.Automatic, 8)
    raw(this.X, packet)
    record.redirected = false
  }

  private async onEvent(event: XEvent): Promise<void> {
    switch (event.name) {
      case 'CreateNotify': {
        if (event.parent !== this.root || event.overrideRedirect) return
        if (!this.expecting()) return
        const owner = await this.ownerOf(event.wid)
        if (owner !== null) await this.consider(event.wid, owner, true, event.width, event.height)
        return
      }
      case 'DestroyNotify': {
        for (const record of this.launches.values()) {
          if (record.wid === event.wid) {
            // The shield died with the window. The next top-level of this launch is caught again.
            record.wid = null
            record.shield = null
            record.redirected = false
            record.caught = false
            record.shown = false
            if (this.shownLaunch === record.launch) this.shownLaunch = null
            this.emit({ event: 'lost', launch: record.launch })
          }
        }
        return
      }
      case 'ConfigureNotify': {
        // An app that resizes or moves its own window while shown is put back where the dock wants it.
        for (const record of this.launches.values()) {
          if (record.wid !== event.wid || !record.shown || !record.rect) continue
          const r = record.rect
          if (event.x !== r.x || event.y !== r.y || event.width !== r.width || event.height !== r.height) {
            this.X.ConfigureWindow(record.wid, { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) })
          }
        }
        return
      }
      case 'ButtonPress': return this.onPress(event)
      case 'KeyPress':
      case 'KeyRelease': return this.onKey(event)
      case 'FocusIn': {
        if (event.wid !== this.electron || this.want !== 'app' || this.shownLaunch === null) return
        const shown = this.launches.get(this.shownLaunch)
        if (shown?.wid) {
          // The WM re-focused Electron after a click into the app: give the keyboard back.
          this.X.SetInputFocus(shown.wid, RevertToParent)
          this.emit({ event: 'log', message: 'focus redirected to the app' })
        }
        return
      }
    }
  }

  private expecting(): boolean {
    for (const record of this.launches.values()) if (!record.caught) return true
    return false
  }

  /** The window's creator, from X-Resource, or null when it cannot be told. */
  private ownerOf(wid: number): Promise<number | null> {
    const res = this.res
    if (!res) return Promise.resolve(null)
    return new Promise((done) => {
      res.QueryClientIds([{ client: wid, mask: LocalClientPID }], (error, ids) => {
        if (error) { done(null); return true }
        const value = ids?.find((id) => id.value.length)?.value[0]
        done(value ?? null)
        return true
      })
    })
  }

  /** A new or existing top-level created by `owner`: dock it if it belongs to a launch waiting for one. */
  private async consider(wid: number, owner: number, fresh: boolean, width?: number, height?: number): Promise<void> {
    const record = [...this.launches.values()].find((entry) => !entry.caught && !entry.catching && belongs(owner, entry.pid, entry.unit))
    if (!record) return
    const geometry = width && height ? { width, height } : await this.call<{ width: number; height: number }>((cb) => this.X.GetGeometry(wid, cb)).catch(() => null)
    // Apps also create 1×1 helper windows (clipboard and the like); those stay where they are.
    if (!geometry || geometry.width <= 50 || geometry.height <= 50) return
    const attributes = await this.call<{ overrideRedirect: number; klass: number; mapState: number }>((cb) => this.X.GetWindowAttributes(wid, cb)).catch(() => null)
    if (!attributes || attributes.overrideRedirect || attributes.klass === InputOnly) return
    record.catching = true
    try {
      const started = Date.now()
      const tree = await this.call<{ parent: number }>((cb) => this.X.QueryTree(wid, cb))
      let how: 'early' | 'late' = 'early'
      if (tree.parent !== this.root || attributes.mapState !== IsUnmapped) {
        how = 'late'
        await this.withdraw(wid)
      }
      // One server grab around the change, so no map request can slip in between.
      this.X.GrabServer()
      try {
        this.X.ChangeWindowAttributes(wid, { overrideRedirect: 1, eventMask: StructureNotify })
        this.X.ReparentWindow(wid, this.electron, -10_000, 0)
      } finally {
        this.X.UngrabServer()
      }
      await this.X.sync()
      if (how === 'late') this.X.MapWindow(wid)
      record.wid = wid
      record.caught = true
      // Parked from birth: redirected, so it draws for a model before it is ever shown.
      this.redirect(record)
      record.shield = await this.makeShield(wid, geometry.width, geometry.height)
      await this.X.sync()
      this.emit({ event: 'captured', launch: record.launch, wid, how, ms: Date.now() - started, fresh })
    } catch (error) {
      this.emit({ event: 'log', message: `could not dock the window of launch ${record.launch}: ${String(error)}` })
    } finally {
      record.catching = false
    }
  }

  /** Takes a window back from the window manager (ICCCM withdraw) and waits for the hand-back. */
  private async withdraw(wid: number): Promise<void> {
    this.X.UnmapWindow(wid)
    const unmap = Buffer.alloc(32)
    unmap.writeUInt8(18, 0) // UnmapNotify
    unmap.writeUInt32LE(this.root >>> 0, 4)
    unmap.writeUInt32LE(wid >>> 0, 8)
    this.X.SendEvent(this.root, false, SubstructureRedirect | SubstructureNotify, unmap)
    await this.X.sync()
    const wmState = await this.atom('WM_STATE')
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const tree = await this.call<{ parent: number }>((cb) => this.X.QueryTree(wid, cb))
      if (tree.parent === this.root) {
        const state = await this.call<{ data: Buffer }>((cb) => this.X.GetProperty(0, wid, wmState, wmState, 0, 2, cb)).catch(() => null)
        if (!state || state.data.length < 4 || state.data.readUInt32LE(0) === 0) return
      }
      await new Promise((done) => setTimeout(done, 10))
    }
    throw new Error('the window manager did not hand the window back within 5 seconds')
  }

  private async makeShield(app: number, width: number, height: number): Promise<number> {
    const shield = this.X.AllocID()
    this.X.CreateWindow(shield, app, 0, 0, Math.max(1, width), Math.max(1, height), 0, 0, InputOnly, 0, { eventMask: KeyPress | KeyRelease })
    // A synchronous passive grab: a press freezes the pointer until onPress decides where it goes.
    this.X.GrabButton(shield, true, ButtonPress, GrabModeSync, GrabModeAsync, 0, 0, 0, AnyModifier)
    await this.X.sync()
    return shield
  }

  private onPress(event: XEvent): void {
    const record = [...this.launches.values()].find((entry) => entry.shield === event.wid)
    if (!record?.wid) {
      this.X.AllowEvents(ReplayPointer, event.time ?? 0)
      return
    }
    // Buttons 4-7 are the wheel: scroll the app, leave the keyboard where it is.
    if ((event.keycode ?? event.detail ?? 1) >= 4) {
      this.X.AllowEvents(ReplayPointer, event.time ?? 0)
      return
    }
    this.want = 'app'
    this.X.SetInputFocus(record.wid, RevertToParent)
    // Replay with the shield still mapped (it selects no pointer events, so the press propagates
    // to the app); unmapping first would lose the press.
    this.X.AllowEvents(ReplayPointer, event.time ?? 0)
    this.X.UnmapWindow(event.wid)
  }

  private onKey(event: XEvent): void {
    if (!this.electron || !event.rawData) return
    if (![...this.launches.values()].some((entry) => entry.shield === event.wid)) return
    // The same key, addressed to Electron's window. Chromium accepts synthetic keys.
    const forwarded = Buffer.from(event.rawData.subarray(0, 32))
    forwarded.writeUInt32LE(this.electron >>> 0, 12)
    forwarded.writeUInt32LE(0, 16)
    this.X.SendEvent(this.electron, false, event.name === 'KeyPress' ? KeyPress : KeyRelease, forwarded)
  }

  private atom(name: string): Promise<number> {
    const known = this.atoms.get(name)
    if (known) return Promise.resolve(known)
    return this.call<number>((cb) => this.X.InternAtom(false, name, cb)).then((value) => { this.atoms.set(name, value); return value })
  }

  private call<T>(request: (callback: (error: unknown, value: T) => boolean) => void): Promise<T> {
    return new Promise((done, fail) => request((error, value) => {
      if (error) fail(error instanceof Error ? error : new Error(String(error)))
      else done(value)
      return true
    }))
  }

  private log(message: string, error: unknown): void {
    this.emit({ event: 'log', message: `${message}: ${error instanceof Error ? error.message : JSON.stringify(error)}` })
  }
}

/** A request node-x11 has no correct template for, written straight to the connection. */
function raw(X: XClient, packet: Buffer): void {
  const client = X as XClient & { seq_num: number; pack_stream: { put: (b: Buffer) => void; submit: () => void } }
  client.seq_num++
  client.pack_stream.put(packet)
  client.pack_stream.submit()
}

/** True when `pid` is `ancestor` or a process it started (an app may relaunch itself, e.g. on a safe GPU path). */
export function isOrDescends(pid: number, ancestor: number, parentOf: (pid: number) => number | null = parentPid): boolean {
  let current: number | null = pid
  for (let depth = 0; current && current > 1 && depth < 8; depth++) {
    if (current === ancestor) return true
    current = parentOf(current)
  }
  return false
}

/** The launch owns a window made by its process, a process it started, or anything in its scope. */
function belongs(owner: number, pid: number, unit: string | null): boolean {
  if (isOrDescends(owner, pid)) return true
  if (!unit) return false
  try {
    return readFileSync(`/proc/${owner}/cgroup`, 'utf8').includes(`/${unit}.scope`)
  } catch {
    return false
  }
}

function parentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name may hold spaces and parentheses; the fields after its last ')' are fixed.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[1]) || null
  } catch {
    return null
  }
}

function transport(): Transport {
  const port = (process as unknown as { parentPort?: { on: (event: 'message', listener: (e: { data: HelperRequest }) => void) => void; postMessage: (message: unknown) => void } }).parentPort
  if (port) return { send: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (e) => listener(e.data)) }
  let buffer = ''
  return {
    send: (message) => { process.stdout.write(JSON.stringify(message) + '\n') },
    onMessage: (listener) => {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) listener(JSON.parse(line) as HelperRequest)
        }
      })
      process.stdin.on('end', () => process.exit(0))
    }
  }
}

async function main(): Promise<void> {
  const channel = transport()
  let dock: X11Dock | null = null
  const ready = X11Dock.connect((event) => channel.send(event)).then((value) => { dock = value; return value })
  ready.catch((error: unknown) => channel.send({ event: 'fatal', message: `Craft Studio could not reach the X display (${error instanceof Error ? error.message : String(error)}). Docked apps need an X11 session.` }))
  // Requests run one at a time, in order, so a park can never overtake the show before it.
  let queue: Promise<unknown> = Promise.resolve()
  channel.onMessage((request) => {
    queue = queue.then(async () => {
      try {
        const result = await (dock ?? await ready).handle(request)
        channel.send({ id: request.id, ok: true, result })
      } catch (error) {
        channel.send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

if (process.env.CRAFT_X11_HELPER === '1') void main()
