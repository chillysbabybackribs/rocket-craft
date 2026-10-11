import { app, ipcMain, screen, utilityProcess, type BrowserWindow, type UtilityProcess, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CRAFT_APPS, craftApp } from '../shared/craft-apps.ts'
import type { CraftAppInfo, CraftBounds, CraftRunState, CraftState } from '../shared/types.ts'
import { CraftDock, checkBounds, xidOf } from './craft-dock.ts'
import type { HelperEvent, HelperReply, HelperRequest } from './craft-dock/protocol.ts'
import { CraftInstaller, craftAppsHome, type InstallEvent, type InstallRecord } from './craft-install.ts'
import { CraftLauncher, setLimits } from './craft-launch.ts'

// Main's side of the Craft apps: the IPC behind `window.craft`, the installer, the dock and the
// X11 helper process. Only the window's own page may call these; model tools never install, and
// the model-tools phase reaches running apps through `CraftStudio.dock` (touch, controlOf).

export const CRAFT_STATE_CHANNEL = 'craft:state'

type Pending = { done: (value: unknown) => void; fail: (error: Error) => void }

/** The X11 helper as a utility process: one request at a time in its own order, events beside. */
class HelperClient {
  private child: UtilityProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private electron = 0
  private stopped = false
  fatal: string | null = null

  constructor(private readonly onEvent: (event: HelperEvent) => void, private readonly log: (message: string) => void) {}

  start(electron: number): void {
    this.electron = electron
    this.spawn()
  }

  private spawn(): void {
    const child = utilityProcess.fork(join(import.meta.dirname, 'craft-x11.js'), [], {
      serviceName: 'Craft Studio X11 Dock',
      env: { ...process.env, CRAFT_X11_HELPER: '1' },
      stdio: 'inherit'
    })
    this.child = child
    child.on('message', (message: HelperReply | HelperEvent) => {
      if ('id' in message) {
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (!waiter) return
        if (message.ok) waiter.done(message.result)
        else waiter.fail(new Error(message.error))
      } else {
        if (message.event === 'fatal') this.fatal = message.message
        this.onEvent(message)
      }
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      for (const waiter of this.pending.values()) waiter.fail(new Error('The window helper stopped.'))
      this.pending.clear()
      if (this.stopped) return
      // Its redirects and shields died with it; docked windows stay where they are. Start a new
      // one so later launches still dock.
      this.log(`the X11 helper exited (${code}); restarting it`)
      setTimeout(() => { if (!this.stopped) this.spawn() }, 500)
    })
    void this.request({ op: 'init', electron: this.electron }).then(
      (result) => this.log(`X11 helper ready: ${JSON.stringify(result)}`),
      (error: unknown) => this.log(`X11 helper init failed: ${String(error)}`)
    )
  }

  request(request: DistributiveOmit<HelperRequest, 'id'>): Promise<unknown> {
    if (this.fatal) return Promise.reject(new Error(this.fatal))
    const child = this.child
    if (!child) return Promise.reject(new Error('The window helper is not running. Restart Craft Studio.'))
    const id = ++this.seq
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      child.postMessage({ id, ...request })
    })
  }

  stop(): void {
    this.stopped = true
    this.child?.kill()
    this.child = null
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export class CraftStudio {
  readonly installer: CraftInstaller
  readonly dock: CraftDock
  private readonly helper: HelperClient
  private readonly states = new Map<string, CraftState>()
  private window: BrowserWindow | null = null
  private readonly journal: (message: string) => void

  constructor(journal: (message: string) => void) {
    this.journal = journal
    const userData = app.getPath('userData')
    this.installer = new CraftInstaller({
      home: craftAppsHome(),
      profileFile: join(userData, 'craft-apps.json'),
      onEvent: (event) => this.onInstall(event)
    })
    const launcher = new CraftLauncher({
      runtimeDir: join(process.env.XDG_RUNTIME_DIR || join(userData, 'run'), `craft-studio-${process.pid}`),
      logsDir: join(userData, 'craft-logs'),
      settingsOf: (id) => this.installer.settingsOf(id),
      binaries: (id) => this.installer.binaries(id)
    })
    this.helper = new HelperClient((event) => this.onHelperEvent(event), (message) => this.log(message))
    this.dock = new CraftDock({
      x: (request) => this.helper.request(request),
      start: (entry, launch, folder) => launcher.start(entry, launch, folder),
      setLimits,
      stop: (started) => launcher.stop(started),
      scale: () => this.scale(),
      content: () => this.content(),
      app: craftApp,
      onRun: (id, run, error) => this.onRun(id, run, error),
      readPressure: () => readFile('/proc/pressure/memory', 'utf8'),
      log: (message) => this.log(message)
    })
    for (const entry of CRAFT_APPS) this.states.set(entry.id, { id: entry.id, installState: 'none', run: 'stopped' })
    void this.installer.list().then((records) => {
      for (const record of records) this.patch(record.id, { installState: 'installed' })
    })
  }

  /** Called once the window exists: the helper needs Electron's X window to dock into. */
  attach(window: BrowserWindow): void {
    this.window = window
    if (process.platform !== 'linux' || !process.env.DISPLAY) {
      this.log('no X11 display: apps cannot be docked in this session')
      return
    }
    this.helper.start(xidOf(window.getNativeWindowHandle()))
  }

  registerIpc(): void {
    const own = (sender: WebContents): void => {
      if (!this.window || sender !== this.window.webContents) throw new Error('The app manager only answers Craft Studio’s own window.')
    }
    ipcMain.handle('craft:catalog', (event) => { own(event.sender); return this.catalog() })
    ipcMain.handle('craft:install', async (event, id: string) => { own(event.sender); await this.installer.install(String(id)) })
    ipcMain.handle('craft:remove', async (event, id: string) => { own(event.sender); await this.remove(String(id)) })
    ipcMain.handle('craft:show', async (event, id: string, bounds: CraftBounds, folder?: string | null) => {
      own(event.sender)
      if (this.helper.fatal) throw new Error(this.helper.fatal)
      await this.dock.show(String(id), checkBounds(bounds), typeof folder === 'string' && folder ? folder : null)
    })
    ipcMain.handle('craft:set-bounds', async (event, bounds: CraftBounds) => { own(event.sender); await this.dock.setBounds(checkBounds(bounds)) })
    ipcMain.handle('craft:hide', async (event) => { own(event.sender); await this.dock.hide() })
    ipcMain.handle('craft:states', (event) => { own(event.sender); return [...this.states.values()] })
    ipcMain.on('craft:pointerdown', (event) => {
      if (this.window && event.sender === this.window.webContents) void this.dock.pointerDown()
    })
  }

  async catalog(): Promise<CraftAppInfo[]> {
    const installed = new Map<string, InstallRecord>((await this.installer.list()).map((record) => [record.id, record]))
    return CRAFT_APPS.map((entry) => {
      const record = installed.get(entry.id)
      return {
        id: entry.id, name: entry.name, likeName: entry.likeName, shortName: entry.shortName, initials: entry.initials,
        accent: entry.accent, description: entry.description, repo: entry.repo, version: entry.version,
        extensions: [...entry.extensions], downloadBytes: entry.downloadBytes,
        sizeBytes: record?.sizeBytes ?? entry.downloadBytes,
        installed: !!record,
        installedVersion: record?.version ?? null
      }
    })
  }

  private async remove(id: string): Promise<void> {
    // The user asked for it, so a running copy is closed first; nothing else ever closes an app.
    await this.dock.stop(id)
    await this.installer.remove(id)
  }

  /** Craft Studio is quitting: every app it started stops with it. */
  async quit(): Promise<void> {
    await this.dock.stopAll().catch((error: unknown) => this.log(`stopping apps failed: ${String(error)}`))
    this.helper.stop()
  }

  private onHelperEvent(event: HelperEvent): void {
    if (event.event === 'log') this.log(`x11: ${event.message}`)
    else if (event.event === 'fatal') this.log(event.message)
    else this.dock.onHelperEvent(event)
  }

  private onInstall(event: InstallEvent): void {
    if (event.state === 'installing') this.patch(event.id, { installState: 'installing', progress: event.progress, error: undefined })
    else if (event.state === 'installed') this.patch(event.id, { installState: 'installed', progress: undefined, error: undefined })
    else if (event.state === 'failed') this.patch(event.id, { installState: 'failed', progress: undefined, error: event.error })
    else this.patch(event.id, { installState: 'none', progress: undefined, error: undefined })
  }

  private onRun(id: string, run: CraftRunState, error?: string): void {
    this.patch(id, { run, error })
  }

  private patch(id: string, change: Partial<CraftState>): void {
    const current = this.states.get(id) ?? { id, installState: 'none', run: 'stopped' }
    const next: CraftState = { ...current, ...change, id }
    for (const key of Object.keys(next) as Array<keyof CraftState>) if (next[key] === undefined) delete next[key]
    this.states.set(id, next)
    const contents = this.window?.webContents
    if (contents && !contents.isDestroyed()) contents.send(CRAFT_STATE_CHANNEL, next)
  }

  private scale(): number {
    if (!this.window || this.window.isDestroyed()) return 1
    const display = screen.getDisplayMatching(this.window.getBounds())
    return display.scaleFactor * this.window.webContents.getZoomFactor()
  }

  private content(): { width: number; height: number } | undefined {
    if (!this.window || this.window.isDestroyed()) return undefined
    const [width, height] = this.window.getContentSize()
    const factor = screen.getDisplayMatching(this.window.getBounds()).scaleFactor
    return { width: Math.round(width! * factor), height: Math.round(height! * factor) }
  }

  private log(message: string): void {
    this.journal(message)
  }
}
