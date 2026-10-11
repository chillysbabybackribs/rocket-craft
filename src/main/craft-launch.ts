import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchArgs, type CraftAppManifest } from '../shared/craft-apps.ts'
import type { Limits, Started } from './craft-dock.ts'

// Starting a docked app's process. Each launch runs in its own systemd user scope, so the dock can
// change its memory and CPU limits while it runs (`systemctl --user set-property --runtime`, no
// root needed) and stop everything it started, children included. `systemd-run --scope` execs the
// app itself, so the spawned pid is the app's (checked in the spike).
//
// The app gets its own settings folders (XDG config, data, cache, state under the apps home's
// `settings/<id>`), never the user's own `~/.config/<app>`: a standalone install keeps its
// preferences, and the docked copy never picks up a setting that breaks docking. Craft Studio's and
// Electron's own variables are dropped, and WAYLAND_DISPLAY with them: an app that chose Wayland
// could not be docked into an X11 window.

export type LaunchOptions = {
  /** Folder for token and control files (0700). */
  runtimeDir: string
  /** Folder for each app's output log. */
  logsDir: string
  settingsOf: (id: string) => string
  binaries: (id: string) => Promise<{ bin: string; cli: string; version: string } | null>
  /** Unit names carry this, so two Craft Studios (a test and the real one) never collide. */
  tag?: string
}

/** A free loopback port, chosen by the kernel. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => done(port))
    })
  })
}

/** The environment a docked app starts with. */
export function appEnv(base: NodeJS.ProcessEnv, settings: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (/^(CRAFT_|ROCKET_|ELECTRON_|CHROME_|GOOGLE_API|NODE_OPTIONS$|WAYLAND_DISPLAY$|ORIGINAL_XDG_CURRENT_DESKTOP$)/.test(name)) continue
    env[name] = value
  }
  // Electron rewrites XDG_CURRENT_DESKTOP for itself and keeps the original here.
  if (base.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = base.ORIGINAL_XDG_CURRENT_DESKTOP
  env.XDG_CONFIG_HOME = join(settings, 'config')
  env.XDG_DATA_HOME = join(settings, 'data')
  env.XDG_CACHE_HOME = join(settings, 'cache')
  env.XDG_STATE_HOME = join(settings, 'state')
  return env
}

let systemdChecked: Promise<boolean> | null = null

/** Whether `systemd-run --user --scope` works here (it needs a user manager and its bus). */
export function systemdAvailable(): Promise<boolean> {
  systemdChecked ??= new Promise((done) => {
    const probe = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' })
    probe.on('error', () => done(false))
    probe.on('exit', (code) => done(code === 0))
  })
  return systemdChecked
}

function runQuiet(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => { err += chunk })
    child.on('error', fail)
    child.on('exit', (code) => code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} failed: ${err.trim().slice(0, 200)}`)))
  })
}

/** `systemctl --user set-property --runtime <unit>.scope MemoryHigh=… CPUWeight=…` */
export function setLimits(unit: string, limits: Limits): Promise<void> {
  return runQuiet('systemctl', ['--user', 'set-property', '--runtime', `${unit}.scope`, `MemoryHigh=${limits.memoryHigh}`, `CPUWeight=${limits.cpuWeight}`])
}

/** The cgroup folder a process sits in, from /proc. */
async function cgroupOf(pid: number): Promise<string | null> {
  try {
    const line = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find((entry) => entry.startsWith('0::'))
    return line ? join('/sys/fs/cgroup', line.slice(3)) : null
  } catch {
    return null
  }
}

async function cgroupEmpty(dir: string): Promise<boolean> {
  try {
    return !(await readFile(join(dir, 'cgroup.procs'), 'utf8')).trim()
  } catch {
    return true
  }
}

export class CraftLauncher {
  private readonly options: LaunchOptions
  private readonly tag: string

  constructor(options: LaunchOptions) {
    this.options = options
    this.tag = options.tag ?? String(process.pid)
  }

  async start(app: CraftAppManifest, launch: number, folder: string | null): Promise<Started> {
    const found = await this.options.binaries(app.id)
    if (!found) throw new Error(`${app.name} is not installed. Install it from the catalog first.`)
    const { runtimeDir, logsDir } = this.options
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    await mkdir(logsDir, { recursive: true })
    const settings = this.options.settingsOf(app.id)
    for (const sub of ['config', 'data', 'cache', 'state']) await mkdir(join(settings, sub), { recursive: true })

    const port = app.control.kind === 'port' ? await freePort() : null
    const controlFile = app.control.kind === 'file' ? join(runtimeDir, `${app.id}-${launch}.control.json`) : null
    if (controlFile) await rm(controlFile, { force: true })
    let tokenFile: string | null = null
    if (app.auth.kind === 'tokenFile') {
      tokenFile = join(runtimeDir, `${app.id}-${launch}.token`)
      await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    }
    const args = launchArgs(app, { port: port ?? undefined, controlFile: controlFile ?? undefined, tokenFile: tokenFile ?? undefined, folder })
    const env = appEnv(process.env, settings)
    const cwd = folder || homedir()
    const log = openSync(join(logsDir, `${app.id}.log`), 'a')
    const unit = (await systemdAvailable()) ? `craft-studio-${app.id}-${this.tag}-${launch}` : null
    const command = unit ? 'systemd-run' : found.bin
    const commandArgs = unit
      ? ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '-p', 'MemoryHigh=infinity', '-p', 'CPUWeight=100', '--', found.bin, ...args]
      : args
    const child = spawn(command, commandArgs, { env, cwd, stdio: ['ignore', log, log] })
    closeSync(log)
    const pid = await new Promise<number>((done, fail) => {
      child.once('spawn', () => done(child.pid!))
      child.once('error', (error) => fail(new Error(`${app.name} could not be started (${error.message}). Remove it and install it again.`)))
    })
    const firstExit = new Promise<{ code: number | null; signal: string | null }>((done) => child.once('exit', (code, signal) => done({ code, signal })))
    // The scope's cgroup outlives the first process when an app relaunches itself; the launch is
    // over only when the scope is empty.
    const cgroup = unit ? await waitForCgroup(pid, unit) : null
    const exited = firstExit.then(async (result) => {
      if (cgroup) {
        while (!(await cgroupEmpty(cgroup))) await new Promise((wait) => setTimeout(wait, 1000))
      }
      if (tokenFile) await rm(tokenFile, { force: true })
      if (controlFile) await rm(controlFile, { force: true })
      return result
    })
    const control = { port, tokenFile, controlFile, configHome: join(settings, 'config'), cli: found.cli, folder }
    const started: Started & { child: typeof child; cgroup: string | null } = { pid, unit, control, exited, child, cgroup }
    return started
  }

  /** SIGTERM to everything in the launch, then SIGKILL after three seconds. */
  async stop(started: Started): Promise<void> {
    const signal = (name: 'SIGTERM' | 'SIGKILL'): Promise<void> => started.unit
      ? runQuiet('systemctl', ['--user', 'kill', `--signal=${name}`, `${started.unit}.scope`]).catch(() => killPid(started.pid, name))
      : killPid(started.pid, name)
    await signal('SIGTERM')
    const gone = await Promise.race([started.exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 3000))])
    if (!gone) await signal('SIGKILL')
  }
}

async function killPid(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

/** The scope's cgroup, once systemd has moved the process into it (a few milliseconds after start). */
async function waitForCgroup(pid: number, unit: string): Promise<string | null> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const dir = await cgroupOf(pid)
    if (dir?.endsWith(`/${unit}.scope`)) return dir
    if (dir === null) return null
    await new Promise((wait) => setTimeout(wait, 10))
  }
  return null
}
