import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CRAFT_APPS, craftApp, releaseUrl, type CraftAppManifest } from '../shared/craft-apps.ts'

// Installing a Craft app: the pinned release tar.gz is downloaded over HTTPS, checked against the
// release's SHA256SUMS.txt and against the hash pinned in the manifest, and unpacked to
// `<apps home>/apps/<id>/<version>/`. The apps home is `~/.local/share/craft-studio` (or
// `$XDG_DATA_HOME/craft-studio`); tests point it elsewhere with CRAFT_APPS_DIR. CRAFT_DATA_DIR is
// not used for this because it already names the agent host's profile folder.
//
// The disk holds the truth about what is unpacked (a marker file written last), and the profile's
// `craft-apps.json` records which apps this profile installed, so a test profile never shows the
// user's own installs. Removing deletes only the unpacked app; the documents an app wrote stay
// where they are, and its settings under `settings/<id>` are kept for a reinstall.
//
// Only the renderer's IPC reaches install and remove. Model tools never install.

export type InstallRecord = {
  id: string
  version: string
  sha256: string
  installedAt: number
  sizeBytes: number
}

export type InstallEvent =
  | { id: string; state: 'installing'; progress: number }
  | { id: string; state: 'installed'; record: InstallRecord }
  | { id: string; state: 'failed'; error: string }
  | { id: string; state: 'none' }

export type CraftInstallerOptions = {
  /** `~/.local/share/craft-studio` or CRAFT_APPS_DIR. */
  home: string
  /** The profile's record of installs, `<userData>/craft-apps.json`. */
  profileFile: string
  apps?: readonly CraftAppManifest[]
  /** Where a release file comes from; tests serve them from a loopback server. */
  urlOf?: (app: CraftAppManifest, file: string) => string
  /** Tests only: plain HTTP is allowed to 127.0.0.1. Production downloads are HTTPS only. */
  allowLoopbackHttp?: boolean
  onEvent?: (event: InstallEvent) => void
  /** A download that sends nothing for this long is abandoned. */
  idleTimeoutMs?: number
}

const MARKER = '.craft-install.json'

/** `$CRAFT_APPS_DIR`, else `$XDG_DATA_HOME/craft-studio`, else `~/.local/share/craft-studio`. */
export function craftAppsHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CRAFT_APPS_DIR) return resolve(env.CRAFT_APPS_DIR)
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share')
  return join(data, 'craft-studio')
}

/** The `<hash>  <name>` line for `name` in a SHA256SUMS.txt, or null. Accepts the binary-mode `*name`. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === name) return match[1]!.toLowerCase()
  }
  return null
}

/** Every member of the tarball must sit under its one top folder, with no `..` and no absolute path. */
export function checkMembers(members: string[], folder: string): string | null {
  if (!members.length) return 'The download is an empty archive.'
  for (const raw of members) {
    const name = raw.replace(/^\.\//, '')
    if (isAbsolute(name) || name.split('/').includes('..')) return `The archive has an unsafe path (${raw}).`
    if (name !== folder && name !== `${folder}/` && !name.startsWith(`${folder}/`)) return `The archive has a file outside ${folder}/ (${raw}).`
  }
  return null
}

export class CraftInstaller {
  readonly home: string
  private readonly profileFile: string
  private readonly apps: readonly CraftAppManifest[]
  private readonly urlOf: (app: CraftAppManifest, file: string) => string
  private readonly allowLoopbackHttp: boolean
  private readonly onEvent: (event: InstallEvent) => void
  private readonly idleTimeoutMs: number
  private readonly running = new Map<string, Promise<InstallRecord>>()
  private profileWrite: Promise<void> = Promise.resolve()

  constructor(options: CraftInstallerOptions) {
    this.home = resolve(options.home)
    this.profileFile = options.profileFile
    this.apps = options.apps ?? CRAFT_APPS
    this.urlOf = options.urlOf ?? releaseUrl
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false
    this.onEvent = options.onEvent ?? (() => {})
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
  }

  /** The folder an app's version unpacks to. */
  dirOf(id: string, version: string): string {
    return join(this.home, 'apps', id, version)
  }

  /** The folder an app keeps its settings in (its XDG config, data, cache and state). */
  settingsOf(id: string): string {
    return join(this.home, 'settings', id)
  }

  isInstalling(id: string): boolean {
    return this.running.has(id)
  }

  /** What this profile has installed and is still on disk. */
  async list(): Promise<InstallRecord[]> {
    const profile = await this.readProfile()
    const out: InstallRecord[] = []
    for (const record of Object.values(profile)) {
      if (await this.onDisk(record.id, record.version)) out.push(record)
    }
    return out
  }

  async installed(id: string): Promise<InstallRecord | null> {
    return (await this.list()).find((record) => record.id === id) ?? null
  }

  /** The absolute path of an installed app's desktop binary and CLI. */
  async binaries(id: string): Promise<{ bin: string; cli: string; version: string } | null> {
    const record = await this.installed(id)
    const app = this.apps.find((entry) => entry.id === id)
    if (!record || !app) return null
    const dir = this.dirOf(id, record.version)
    return { bin: join(dir, app.bin), cli: join(dir, app.cli), version: record.version }
  }

  /** Installs the pinned version. A second call while one runs joins it. */
  install(id: string): Promise<InstallRecord> {
    const existing = this.running.get(id)
    if (existing) return existing
    const app = this.apps.find((entry) => entry.id === id)
    if (!app) return Promise.reject(new Error(`Craft Studio has no app called “${id}”. Pick one from the catalog.`))
    const job = this.run(app).then(
      (record) => {
        this.running.delete(id)
        this.onEvent({ id, state: 'installed', record })
        return record
      },
      (error: unknown) => {
        this.running.delete(id)
        const message = error instanceof Error ? error.message : String(error)
        this.onEvent({ id, state: 'failed', error: message })
        throw new Error(message)
      }
    )
    this.running.set(id, job)
    return job
  }

  /** Deletes the unpacked app (every version) and this profile's record of it. */
  async remove(id: string): Promise<void> {
    if (!this.apps.some((entry) => entry.id === id)) throw new Error(`Craft Studio has no app called “${id}”.`)
    if (this.running.has(id)) throw new Error('This app is still installing. Wait for it to finish, then remove it.')
    const target = join(this.home, 'apps', id)
    // Never delete anything outside the apps folder, whatever an id looks like.
    if (relative(join(this.home, 'apps'), target).startsWith('..') || dirname(target) !== join(this.home, 'apps')) {
      throw new Error('Craft Studio refused to remove a folder outside its apps folder.')
    }
    await rm(target, { recursive: true, force: true })
    await this.updateProfile((profile) => { delete profile[id] })
    this.onEvent({ id, state: 'none' })
  }

  private async run(app: CraftAppManifest): Promise<InstallRecord> {
    this.onEvent({ id: app.id, state: 'installing', progress: 0 })
    const final = this.dirOf(app.id, app.version)
    // Another profile may have unpacked this very version already: adopt it.
    const marker = await this.readMarker(app.id, app.version)
    if (marker && marker.sha256 === app.sha256) {
      await this.updateProfile((profile) => { profile[app.id] = marker })
      return marker
    }
    await mkdir(join(this.home, 'apps', app.id), { recursive: true })
    await this.checkSpace(app)
    const work = join(this.home, 'apps', app.id, `.install-${randomBytes(6).toString('hex')}`)
    await mkdir(work, { recursive: true })
    try {
      const sums = await this.fetchText(app, 'SHA256SUMS.txt')
      const listed = sumFor(sums, app.asset)
      if (!listed) throw new Error(`${app.name} ${app.version}’s checksum list does not include ${app.asset}, so it was not installed. Try again later.`)
      if (listed !== app.sha256) {
        throw new Error(`${app.name} ${app.version} was republished upstream since Craft Studio pinned it, so it was not installed. Update Craft Studio’s app list (npm run craft:manifest) and try again.`)
      }
      const archive = join(work, app.asset)
      const actual = await this.download(app, archive)
      if (actual !== app.sha256) throw new Error(`${app.name}’s download did not match its checksum, so it was not installed. Try again; if it fails again, the download is being changed on the way.`)
      this.onEvent({ id: app.id, state: 'installing', progress: 0.92 })
      const problem = checkMembers(await tarList(archive), app.folder)
      if (problem) throw new Error(`${app.name}’s download was not installed: ${problem}`)
      const unpacked = join(work, 'unpacked')
      await mkdir(unpacked)
      await tarExtract(archive, unpacked)
      const top = join(unpacked, app.folder)
      await checkLinks(top)
      for (const file of [app.bin, app.cli]) {
        const info = await lstat(join(top, file)).catch(() => null)
        if (!info?.isFile() || !(info.mode & 0o100)) throw new Error(`${app.name}’s download has no ${file}, so it was not installed. Report this to Craft Studio.`)
      }
      this.onEvent({ id: app.id, state: 'installing', progress: 0.97 })
      await rm(final, { recursive: true, force: true })
      await rename(top, final)
      const record: InstallRecord = { id: app.id, version: app.version, sha256: app.sha256, installedAt: Date.now(), sizeBytes: await sizeOf(final) }
      // The marker is written last: a folder without one is an interrupted install.
      await writeFile(join(final, MARKER), JSON.stringify(record, null, 2))
      await this.updateProfile((profile) => { profile[app.id] = record })
      return record
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  private async checkSpace(app: CraftAppManifest): Promise<void> {
    // The archive and the unpacked app sit side by side until the move: about 3.5× the download.
    const need = app.downloadBytes * 4
    const info = await statfs(join(this.home, 'apps', app.id)).catch(() => null)
    if (!info) return
    const free = Number(info.bavail) * Number(info.bsize)
    if (free < need) {
      throw new Error(`There is not enough free disk space to install ${app.name}: it needs about ${mb(need)} and ${mb(free)} is free. Free some space and try again.`)
    }
  }

  private checkUrl(url: string, app: CraftAppManifest): void {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return
    if (this.allowLoopbackHttp && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return
    throw new Error(`${app.name} was not installed because its download was not served over HTTPS. Try again later.`)
  }

  private async open(app: CraftAppManifest, file: string, signal: AbortSignal): Promise<Response> {
    const url = this.urlOf(app, file)
    this.checkUrl(url, app)
    let response: Response
    try {
      response = await fetch(url, { redirect: 'follow', signal })
    } catch (error) {
      if (signal.aborted) throw new Error(`${app.name}’s download stalled, so it was not installed. Check the network and try again.`)
      throw new Error(`${app.name} could not be downloaded (${error instanceof Error ? error.message : String(error)}). Check the network and try again.`)
    }
    // GitHub redirects release files to its storage host; the final hop must be HTTPS too.
    this.checkUrl(response.url || url, app)
    if (!response.ok) throw new Error(`${app.name} could not be downloaded: the server answered ${response.status} for ${file}. Try again later.`)
    return response
  }

  private async fetchText(app: CraftAppManifest, file: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.idleTimeoutMs)
    try {
      const response = await this.open(app, file, controller.signal)
      const text = await response.text()
      if (text.length > 1_000_000) throw new Error(`${app.name}’s checksum list is unexpectedly large, so it was not installed.`)
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  /** Streams the release archive to `path`, reporting progress, and returns its SHA-256. */
  private async download(app: CraftAppManifest, path: string): Promise<string> {
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), this.idleTimeoutMs)
    const alive = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), this.idleTimeoutMs)
    }
    const hash = createHash('sha256')
    let out: WriteStream | null = null
    try {
      const response = await this.open(app, app.asset, controller.signal)
      const total = Number(response.headers.get('content-length')) || app.downloadBytes
      if (!response.body) throw new Error(`${app.name}’s download was empty. Try again later.`)
      out = createWriteStream(path)
      const stream = out
      const failed = new Promise<never>((_, reject) => stream.once('error', reject))
      failed.catch(() => {})
      let received = 0
      let reported = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        alive()
        received += chunk.byteLength
        // A server that sends far more than it should is not sending this release.
        if (received > app.downloadBytes * 2 + 1_000_000) throw new Error(`${app.name}’s download is much larger than expected, so it was not installed.`)
        hash.update(chunk)
        if (!stream.write(chunk)) await Promise.race([new Promise<void>((done) => stream.once('drain', () => done())), failed])
        const progress = Math.min(0.9, (received / total) * 0.9)
        if (progress - reported >= 0.01) {
          reported = progress
          this.onEvent({ id: app.id, state: 'installing', progress: Math.round(progress * 1000) / 1000 })
        }
      }
      await Promise.race([new Promise<void>((done) => stream.end(done)), failed])
      return hash.digest('hex')
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${app.name}’s download stalled, so it was not installed. Check the network and try again.`)
      throw error
    } finally {
      clearTimeout(timer)
      out?.destroy()
    }
  }

  private async onDisk(id: string, version: string): Promise<boolean> {
    return (await this.readMarker(id, version)) !== null
  }

  private async readMarker(id: string, version: string): Promise<InstallRecord | null> {
    try {
      const record = JSON.parse(await readFile(join(this.dirOf(id, version), MARKER), 'utf8')) as InstallRecord
      return record.id === id && record.version === version ? record : null
    } catch {
      return null
    }
  }

  private async readProfile(): Promise<Record<string, InstallRecord>> {
    try {
      const value = JSON.parse(await readFile(this.profileFile, 'utf8')) as { installed?: Record<string, InstallRecord> }
      return value.installed && typeof value.installed === 'object' ? value.installed : {}
    } catch {
      return {}
    }
  }

  private updateProfile(change: (profile: Record<string, InstallRecord>) => void): Promise<void> {
    // Writes are queued so two installs finishing together cannot drop each other's record.
    this.profileWrite = this.profileWrite.then(async () => {
      const profile = await this.readProfile()
      change(profile)
      await mkdir(dirname(this.profileFile), { recursive: true })
      const temp = `${this.profileFile}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ installed: profile }, null, 2))
      await rename(temp, this.profileFile)
    })
    return this.profileWrite
  }
}

/** The installed app's identity, for errors elsewhere. */
export function appName(id: string): string {
  return craftApp(id)?.name ?? id
}

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { err += chunk })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code === 0) done(Buffer.concat(out).toString('utf8'))
      else fail(new Error(`${command} failed (${code}): ${err.trim().slice(0, 300)}`))
    })
  })
}

function tarList(archive: string): Promise<string[]> {
  return run('tar', ['-tzf', archive]).then((text) => text.split('\n').filter(Boolean))
}

function tarExtract(archive: string, into: string): Promise<string> {
  return run('tar', ['-xzf', archive, '-C', into, '--no-same-owner', '--no-overwrite-dir'])
}

/** A symbolic link in the app must point inside the app. */
async function checkLinks(top: string): Promise<void> {
  const root = await realpath(top)
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path))
        if (target !== root && !target.startsWith(root + sep)) throw new Error(`The download has a link that points outside the app (${relative(top, path)}), so it was not installed.`)
      } else if (entry.isDirectory()) {
        await walk(path)
      }
    }
  }
  await walk(top)
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await sizeOf(path)
    else if (entry.isFile()) total += (await lstat(path)).size
  }
  return total
}
