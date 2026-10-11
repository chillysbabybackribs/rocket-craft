import type { CraftBounds, CraftRunState } from '../shared/types.ts'
import type { CraftAppManifest } from '../shared/craft-apps.ts'
import type { DeviceRect, HelperEvent } from './craft-dock/protocol.ts'

// The docked apps' lives: which one is shown, which are parked, and how much of the machine each
// may use. Main owns this; the X11 work is the helper's (`craft-dock/x11-helper.ts`) and the
// processes are `craft-launch.ts`'s, both injected so the state machine can be tested alone.
//
// The rule (docs/craft-studio-performance-plan.md): what a session costs depends on what is on
// screen and what a model is working in, not on how many apps are open. So no app is ever closed
// to save memory. An app starts on its first show and then runs until the user quits it or Craft
// Studio quits. Each runs in its own systemd scope, and its state sets that scope's limits:
//
// - shown: on screen. No memory limit, full CPU share.
// - working: hidden, but shown or called by a model in the last two minutes. No memory limit, a
//   lower CPU share so the shown app never stutters.
// - resting: hidden and idle for two minutes. Memory above about 64 MB moves to swap, lowest CPU
//   share. Under real memory pressure the limit tightens; an app is still never closed.
//
// Limits are always lifted before the app is shown or called, never after: a squeezed app answers
// an inspect quickly but a full-image edit took 2.6 s squeezed against 0.58 s lifted (spike).
//
// Redirect policy. A parked window that is not Composite-redirected is fully obscured and stops
// drawing, so its screenshots hang; a redirected one keeps drawing, animations included (GridCraft's
// copy marquee cost 9% of a core while parked under mutter). So a parked app is redirected while it
// is working, where a model may need its pixels, and unredirected when it comes to rest, where it
// then draws nothing at all. Calling a resting app (`touch`) redirects it again before the call.

export const REST_AFTER_MS = 120_000
export const CAPTURE_TIMEOUT_MS = 30_000
export const PRESSURE_POLL_MS = 10_000

export type Limits = { memoryHigh: string; cpuWeight: number }

/** The scope limits for a state. `pressed` is real memory pressure, which tightens resting apps. */
export function limitsFor(run: CraftRunState, pressed = false): Limits {
  if (run === 'resting') return pressed ? { memoryHigh: '32M', cpuWeight: 1 } : { memoryHigh: '64M', cpuWeight: 5 }
  if (run === 'working') return { memoryHigh: 'infinity', cpuWeight: 50 }
  return { memoryHigh: 'infinity', cpuWeight: 100 }
}

/** CSS-pixel bounds from the renderer to X pixels in Electron's window, edges rounded, kept inside it. */
export function toDeviceRect(bounds: CraftBounds, scale: number, content?: { width: number; height: number }): DeviceRect {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  let left = Math.round(bounds.x * s)
  let top = Math.round(bounds.y * s)
  let right = Math.round((bounds.x + Math.max(0, bounds.width)) * s)
  let bottom = Math.round((bounds.y + Math.max(0, bounds.height)) * s)
  if (content) {
    left = Math.min(Math.max(0, left), content.width)
    top = Math.min(Math.max(0, top), content.height)
    right = Math.min(Math.max(left, right), content.width)
    bottom = Math.min(Math.max(top, bottom), content.height)
  }
  // X refuses zero-sized windows.
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** Electron's native handle on X11: the window's XID, 8 bytes little-endian on 64-bit builds. */
export function xidOf(handle: Buffer): number {
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}

/** The renderer's bounds, checked: four finite numbers, no negative size. */
export function checkBounds(value: unknown): CraftBounds {
  const bounds = value as Partial<CraftBounds> | null
  const ok = !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every((n) => typeof n === 'number' && Number.isFinite(n))
  if (!ok || bounds!.width! < 0 || bounds!.height! < 0) throw new Error('The app region’s size was not understood. Resize the window and try again.')
  return { x: bounds!.x!, y: bounds!.y!, width: bounds!.width!, height: bounds!.height! }
}

/** The `some avg10` share of /proc/pressure/memory: the % of the last 10 s some task waited on memory. */
export function memoryPressure(text: string): number {
  const match = /^some\s.*?avg10=([\d.]+)/m.exec(text)
  return match ? Number(match[1]) : 0
}

/** Above this, resting apps are squeezed harder. */
export const PRESSURE_THRESHOLD = 10

export type ControlInfo = {
  /** Null until known: PdfCraft picks its own port and writes it to its control file. */
  port: number | null
  tokenFile: string | null
  controlFile: string | null
  /** The app's XDG_CONFIG_HOME, where WordCraft writes its key. */
  configHome: string
  cli: string
  folder: string | null
}

/** A started app process, as `craft-launch.ts` hands it over. */
export type Started = {
  pid: number
  /** The systemd scope's unit name, without `.scope`; null when systemd could not be used. */
  unit: string | null
  control: ControlInfo
  /** Settles when every process of the launch is gone. */
  exited: Promise<{ code: number | null; signal: string | null }>
}

export type DockDeps = {
  /** Requests to the X11 helper. */
  x: (request: XRequest) => Promise<unknown>
  start: (app: CraftAppManifest, launch: number, folder: string | null) => Promise<Started>
  setLimits: (unit: string, limits: Limits) => Promise<void>
  stop: (started: Started) => Promise<void>
  /** The renderer's CSS pixels to X pixels. */
  scale: () => number
  /** The window's content size in X pixels, to keep a docked app inside it. */
  content: () => { width: number; height: number } | undefined
  app: (id: string) => CraftAppManifest | undefined
  onRun: (id: string, run: CraftRunState, error?: string) => void
  readPressure?: () => Promise<string>
  now?: () => number
  log?: (message: string) => void
}

export type XRequest =
  | { op: 'expect'; launch: number; pid: number; unit: string | null }
  | { op: 'forget'; launch: number }
  | { op: 'show'; launch: number; rect: DeviceRect }
  | { op: 'park'; launch: number; rect: DeviceRect | null; redirect: boolean }
  | { op: 'redirect'; launch: number; on: boolean }
  | { op: 'wantElectron' }

type Run = {
  launch: number
  app: CraftAppManifest
  started: Started
  run: CraftRunState
  captured: boolean
  waiters: Array<{ done: () => void; fail: (error: Error) => void }>
  hiddenAt: number
  lastUseAt: number
  restTimer: ReturnType<typeof setTimeout> | null
  captureTimer: ReturnType<typeof setTimeout> | null
  redirected: boolean
  applied: string
  stopping: boolean
  shownRect: DeviceRect | null
}

export class CraftDock {
  private readonly deps: DockDeps
  private readonly runs = new Map<string, Run>()
  private readonly starting = new Map<string, Promise<Run>>()
  private bounds: CraftBounds | null = null
  private want: string | null = null
  private nextLaunch = 1
  private queue: Promise<void> = Promise.resolve()
  private pressed = false
  private pressureTimer: ReturnType<typeof setInterval> | null = null
  private folder: string | null = null
  private closed = false

  constructor(deps: DockDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  runOf(id: string): CraftRunState {
    return this.runs.get(id)?.run ?? 'stopped'
  }

  shown(): string | null {
    for (const run of this.runs.values()) if (run.run === 'shown') return run.app.id
    return null
  }

  /** How a model reaches a running app (the model-tools phase uses this). */
  controlOf(id: string): ControlInfo | null {
    return this.runs.get(id)?.started.control ?? null
  }

  /** Shows the app, starting it first if needed, and parks whatever was shown. */
  async show(id: string, bounds: CraftBounds, folder?: string | null): Promise<void> {
    const app = this.deps.app(id)
    if (!app) throw new Error(`Craft Studio has no app called “${id}”. Pick one from the dock.`)
    if (folder) this.folder = folder
    this.bounds = bounds
    this.want = id
    const run = await this.ensure(app)
    await this.captured(run)
    await this.reconcile()
  }

  async setBounds(bounds: CraftBounds): Promise<void> {
    this.bounds = bounds
    await this.reconcile()
  }

  /** Parks the shown app: the shelf, the browser or the library has the region now. */
  async hide(): Promise<void> {
    this.want = null
    await this.reconcile()
  }

  /**
   * A model is about to call into the app: start it parked if it is not running, lift its limits
   * and make sure it draws, all before the call. Returns how to reach it.
   */
  async touch(id: string): Promise<ControlInfo> {
    const app = this.deps.app(id)
    if (!app) throw new Error(`Craft Studio has no app called “${id}”.`)
    const run = await this.ensure(app)
    await this.captured(run)
    run.lastUseAt = this.now()
    await this.enqueue(async () => {
      if (run.run === 'resting') await this.become(run, 'working')
      if (run.run === 'working') {
        await this.redirect(run, true)
        this.scheduleRest(run)
      }
    })
    return run.started.control
  }

  /** A press on Craft Studio's own page: the keyboard goes back to the chat. */
  async pointerDown(): Promise<void> {
    if (this.runs.size) await this.deps.x({ op: 'wantElectron' }).catch(() => {})
  }

  /** The helper's events: a window caught or lost. */
  onHelperEvent(event: HelperEvent): void {
    if (event.event === 'captured') {
      const run = this.byLaunch(event.launch)
      if (!run) return
      run.captured = true
      // The helper parks a caught window out of view and redirected.
      run.redirected = true
      if (run.captureTimer) clearTimeout(run.captureTimer)
      run.captureTimer = null
      this.deps.log?.(`${run.app.id}: window docked ${event.how} in ${event.ms} ms`)
      if (run.run === 'starting' && this.want !== run.app.id) {
        run.hiddenAt = this.now()
        void this.enqueue(async () => {
          await this.become(run, 'working')
          this.scheduleRest(run)
        })
      }
      for (const waiter of run.waiters.splice(0)) waiter.done()
      void this.reconcile()
    } else if (event.event === 'lost') {
      const run = this.byLaunch(event.launch)
      if (!run || run.stopping) return
      // The window went away but the process may live on (an app that relaunches itself on a
      // safer GPU path, say): wait for its next window as for the first.
      run.captured = false
      run.redirected = false
      run.shownRect = null
      run.run = 'starting'
      this.deps.onRun(run.app.id, 'starting')
      this.armCaptureTimeout(run)
    }
  }

  /** Stops one app: its own Remove, or Craft Studio quitting. */
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) {
      const pending = this.starting.get(id)
      if (pending) await pending.then((started) => this.stop(started.app.id), () => {})
      return
    }
    run.stopping = true
    if (this.want === id) this.want = null
    await this.deps.stop(run.started)
    await run.started.exited
  }

  /** Stops every app; Craft Studio is quitting. */
  async stopAll(): Promise<void> {
    this.closed = true
    if (this.pressureTimer) clearInterval(this.pressureTimer)
    this.pressureTimer = null
    await Promise.allSettled([...this.starting.values()])
    await Promise.allSettled([...this.runs.keys()].map((id) => this.stop(id)))
  }

  private byLaunch(launch: number): Run | undefined {
    for (const run of this.runs.values()) if (run.launch === launch) return run
    return undefined
  }

  private ensure(app: CraftAppManifest): Promise<Run> {
    const existing = this.runs.get(app.id)
    if (existing) return Promise.resolve(existing)
    const pending = this.starting.get(app.id)
    if (pending) return pending
    if (this.closed) return Promise.reject(new Error('Craft Studio is quitting.'))
    const job = this.launch(app).finally(() => this.starting.delete(app.id))
    this.starting.set(app.id, job)
    return job
  }

  private async launch(app: CraftAppManifest): Promise<Run> {
    const launch = this.nextLaunch++
    this.deps.onRun(app.id, 'starting')
    let started: Started
    try {
      started = await this.deps.start(app, launch, this.folder)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.onRun(app.id, 'stopped', message)
      throw new Error(message)
    }
    const now = this.now()
    const run: Run = {
      launch, app, started, run: 'starting', captured: false, waiters: [], hiddenAt: now, lastUseAt: now,
      restTimer: null, captureTimer: null, redirected: false, applied: 'shown', stopping: false, shownRect: null
    }
    this.runs.set(app.id, run)
    started.exited.then(({ code, signal }) => this.exited(run, code, signal))
    this.armCaptureTimeout(run)
    try {
      await this.deps.x({ op: 'expect', launch, pid: started.pid, unit: started.unit })
    } catch (error) {
      this.deps.log?.(`${app.id}: the X11 helper could not watch for its window: ${String(error)}`)
    }
    return run
  }

  private armCaptureTimeout(run: Run): void {
    if (run.captureTimer) clearTimeout(run.captureTimer)
    if (run.captured) return
    run.captureTimer = setTimeout(() => {
      run.captureTimer = null
      if (run.captured || run.stopping) return
      const message = `${run.app.name} started but its window did not appear within ${CAPTURE_TIMEOUT_MS / 1000} seconds, so it was stopped. Try again; if it keeps happening, remove it and install it again.`
      for (const waiter of run.waiters.splice(0)) waiter.fail(new Error(message))
      run.stopping = true
      this.deps.onRun(run.app.id, 'stopped', message)
      void this.deps.stop(run.started)
    }, CAPTURE_TIMEOUT_MS)
    run.captureTimer.unref?.()
  }

  private captured(run: Run): Promise<void> {
    if (run.captured) return Promise.resolve()
    if (!this.runs.has(run.app.id)) return Promise.reject(new Error(`${run.app.name} is not running. Open it again.`))
    return new Promise((done, fail) => run.waiters.push({ done, fail }))
  }

  private exited(run: Run, code: number | null, signal: string | null): void {
    if (this.runs.get(run.app.id) === run) this.runs.delete(run.app.id)
    if (run.restTimer) clearTimeout(run.restTimer)
    if (run.captureTimer) clearTimeout(run.captureTimer)
    void this.deps.x({ op: 'forget', launch: run.launch }).catch(() => {})
    const wasStarting = !run.captured
    const unexpected = !run.stopping && (signal !== null || (code !== null && code !== 0))
    const error = run.stopping ? undefined
      : wasStarting ? `${run.app.name} quit while starting${code !== null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}. Try again; if it keeps happening, remove it and install it again.`
        : unexpected ? `${run.app.name} quit unexpectedly${code !== null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}. Open it again from the dock.` : undefined
    for (const waiter of run.waiters.splice(0)) waiter.fail(new Error(error ?? `${run.app.name} was closed.`))
    if (this.want === run.app.id) this.want = null
    run.run = 'stopped'
    this.deps.onRun(run.app.id, 'stopped', error)
    this.updatePressureWatch()
  }

  /** Brings every app to where `want` and `bounds` say it should be. One pass at a time. */
  private reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const content = this.deps.content()
      const rect = this.bounds ? toDeviceRect(this.bounds, this.deps.scale(), content) : null
      // Park first, so two apps are never shown in the region at once.
      for (const run of this.runs.values()) {
        if (run.app.id === this.want || run.run !== 'shown' || !run.captured) continue
        await this.deps.x({ op: 'park', launch: run.launch, rect, redirect: true })
        run.redirected = true
        run.shownRect = null
        run.hiddenAt = this.now()
        await this.become(run, 'working')
        this.scheduleRest(run)
      }
      const target = this.want ? this.runs.get(this.want) : undefined
      if (!target || !target.captured || !rect) return
      if (target.run === 'shown' && sameRect(target.shownRect, rect)) return
      if (target.run !== 'shown') {
        // Lift before showing, so the user never meets a squeezed app.
        await this.become(target, 'shown')
        if (target.restTimer) clearTimeout(target.restTimer)
        target.restTimer = null
      }
      await this.deps.x({ op: 'show', launch: target.launch, rect })
      target.redirected = false
      target.shownRect = rect
      target.lastUseAt = this.now()
    })
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work)
    this.queue = next.catch((error: unknown) => this.deps.log?.(`dock: ${error instanceof Error ? error.message : String(error)}`))
    return next
  }

  /** Moves a run to a state: its scope's limits first, then the event. */
  private async become(run: Run, state: CraftRunState): Promise<void> {
    if (!this.runs.has(run.app.id) || run.stopping) return
    const limits = limitsFor(state, this.pressed)
    const key = `${limits.memoryHigh}/${limits.cpuWeight}`
    if (run.started.unit && key !== run.applied) {
      try {
        await this.deps.setLimits(run.started.unit, limits)
        run.applied = key
      } catch (error) {
        this.deps.log?.(`${run.app.id}: could not set ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (run.run !== state) {
      run.run = state
      this.deps.onRun(run.app.id, state)
    }
    this.updatePressureWatch()
  }

  private async redirect(run: Run, on: boolean): Promise<void> {
    if (run.redirected === on || run.run === 'shown' || !run.captured) return
    await this.deps.x({ op: 'redirect', launch: run.launch, on })
    run.redirected = on
  }

  private scheduleRest(run: Run): void {
    if (run.restTimer) clearTimeout(run.restTimer)
    const idleSince = Math.max(run.hiddenAt, run.lastUseAt)
    const wait = Math.max(0, idleSince + REST_AFTER_MS - this.now())
    run.restTimer = setTimeout(() => {
      run.restTimer = null
      void this.enqueue(async () => {
        if (run.run !== 'working' || !this.runs.has(run.app.id)) return
        if (this.now() - Math.max(run.hiddenAt, run.lastUseAt) < REST_AFTER_MS) {
          this.scheduleRest(run)
          return
        }
        await this.become(run, 'resting')
        await this.redirect(run, false)
      })
    }, wait)
    run.restTimer.unref?.()
  }

  /** While anything rests, watch memory pressure and tighten resting apps under it. */
  private updatePressureWatch(): void {
    const resting = [...this.runs.values()].some((run) => run.run === 'resting')
    if (resting && !this.pressureTimer && this.deps.readPressure && !this.closed) {
      this.pressureTimer = setInterval(() => { void this.checkPressure() }, PRESSURE_POLL_MS)
      this.pressureTimer.unref?.()
    } else if (!resting && this.pressureTimer) {
      clearInterval(this.pressureTimer)
      this.pressureTimer = null
      this.pressed = false
    }
  }

  async checkPressure(): Promise<void> {
    if (!this.deps.readPressure) return
    const pressed = memoryPressure(await this.deps.readPressure().catch(() => '')) > PRESSURE_THRESHOLD
    if (pressed === this.pressed) return
    this.pressed = pressed
    this.deps.log?.(`memory pressure ${pressed ? 'high: squeezing resting apps harder' : 'back to normal'}`)
    await this.enqueue(async () => {
      for (const run of this.runs.values()) if (run.run === 'resting') await this.become(run, 'resting')
    })
  }
}

function sameRect(a: DeviceRect | null, b: DeviceRect): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
