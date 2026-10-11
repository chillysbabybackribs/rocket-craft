// Spike: host upstream Craft web builds in Electron and measure them.
//
// Each app's static web build is served from the privileged craft:// scheme (craft://<app>/…), a
// secure context with cross-origin isolation headers, the way rocketv1 serves PhotoCraft. Each app
// gets its own partition and its own WebContentsView laid over the right part of one window; the
// left part stands in for the chat. Switching apps hides the other view like a background tab.
//
// A run is one scenario module (scenarios/<name>.mjs) given helpers to open, show, hide, measure
// and capture apps. Results go to results/<scenario>-<label>.json.
//
// Env: SPIKE_SCENARIO, SPIKE_LABEL, SPIKE_USER_DATA (profile dir; reuse it for a warm start),
// SPIKE_WEBGPU=1 (enable WebGPU flags for a real GPU), SPIKE_CACHE=immutable|no-cache.

import { app, BrowserWindow, WebContentsView, ipcMain, protocol, session } from 'electron'
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SCENARIO = process.env.SPIKE_SCENARIO || 'load'
const LABEL = process.env.SPIKE_LABEL || 'run'
const USER_DATA = resolve(process.env.SPIKE_USER_DATA || join(ROOT, 'results', `userdata-${LABEL}`))
const CACHE = process.env.SPIKE_CACHE || 'immutable'

export const APPS = {
  photocraft: { dir: 'web/photocraft/photocraft-web-0.7.0', loader: '#photocraft_loading', query: '' },
  gridcraft: { dir: 'web/gridcraft/gridcraft-web-0.5.0', loader: '#gridcraft_loading', query: '' },
  filmcraft: { dir: 'web/filmcraft/filmcraft-web-0.6.0', loader: '#loading', query: '?empty&norecover&fresh' }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.csv': 'text/csv', '.svg': 'image/svg+xml'
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff'
}

app.setName('craft-web-view-spike')
app.setPath('userData', USER_DATA)
if (process.env.SPIKE_WEBGPU === '1') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-features', 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan')
}
// Xvfb has no GPU: Chromium blocklists WebGL2 there unless told to use SwiftShader, so the
// private-display runs measure software rendering (said so in the report).
if (process.env.SPIKE_SOFT !== '0') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
}
app.commandLine.appendSwitch('remote-debugging-port', '0')
protocol.registerSchemesAsPrivileged([
  { scheme: 'craft', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true, stream: true } }
])

function staticFile(root, pathname) {
  let path
  try { path = decodeURIComponent(pathname) } catch { return null }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`)
  return file === root || file.startsWith(root + sep) ? file : null
}

async function serve(name, request) {
  const url = new URL(request.url)
  const media = url.pathname.startsWith('/__media/')
  const root = media ? join(ROOT, 'media') : join(ROOT, APPS[name].dir)
  const file = staticFile(root, media ? url.pathname.slice('/__media'.length) : url.pathname)
  if (!file || !existsSync(file) || statSync(file).isDirectory()) return new Response('Not found', { status: 404, headers: ISOLATION })
  const ext = extname(file)
  const cache = ext === '.html' || CACHE === 'no-cache' ? 'no-cache' : 'public, max-age=31536000, immutable'
  return new Response(new Uint8Array(await readFile(file)), {
    headers: { ...ISOLATION, 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cache }
  })
}

// ── Measurement helpers ─────────────────────────────────────────────

function kb(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
  return m ? Number(m[1]) : null
}

/**
 * RSS and swap of one process, in MB, from /proc/<pid>/status. Sandboxed renderers are not
 * ptrace-readable, so smaps_rollup (and PSS) is refused; status is world-readable.
 */
export function procMem(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8')
    const mb = (k) => { const v = kb(st, k); return v == null ? null : Math.round(v / 102.4) / 10 }
    return { pid, rssMB: mb('VmRSS'), anonMB: mb('RssAnon'), fileMB: mb('RssFile'), shmemMB: mb('RssShmem'), swapMB: mb('VmSwap') }
  } catch (error) {
    return { pid, error: String(error) }
  }
}

function cpuTicks(pid) {
  try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]) } catch { return null }
}

function cgroupOf(pid) {
  try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() } catch { return null }
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(path) : statSync(path).size
  }
  return total
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── The window and the apps ─────────────────────────────────────────

const WINDOW = { width: 1600, height: 960 }
const RIGHT = { x: 480, y: 32, width: 1120, height: 860 }

class Host {
  constructor(window) {
    this.window = window
    this.views = new Map()
    this.waiters = new Map()
    this.results = { scenario: SCENARIO, label: LABEL, userData: USER_DATA, cache: CACHE, webgpuFlags: process.env.SPIKE_WEBGPU === '1', display: process.env.DISPLAY, electron: process.versions.electron, chrome: process.versions.chrome, startedAt: new Date().toISOString(), log: [] }
    ipcMain.on('craft-ready', (event, info) => {
      for (const [name, entry] of this.views) {
        if (entry.view.webContents === event.sender) {
          entry.ready = info
          this.waiters.get(name)?.(info)
        }
      }
    })
  }

  log(...parts) {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
    console.log(`[spike] ${line}`)
    this.results.log.push(line)
  }

  /** Make an app's view and load it; resolves with timings once its first frame after start-up is drawn. */
  async open(name, { query = APPS[name].query, show = true, timeoutMs = 60_000, onCommit = null, url = null } = {}) {
    const spec = APPS[name]
    const ses = session.fromPartition(`persist:craft-${name}`)
    if (!ses.protocol.isProtocolHandled('craft')) ses.protocol.handle('craft', (request) => serve(name, request))
    ses.on('will-download', (_event, item) => {
      const target = join(ROOT, 'results', 'downloads', name, item.getFilename())
      mkdirSync(dirname(target), { recursive: true })
      item.setSavePath(target)
      this.log(`download from ${name}: ${item.getFilename()} (${item.getTotalBytes()} bytes) -> ${target}`)
      item.once('done', (_e, state) => { (this.downloads ??= []).push({ app: name, file: target, state, bytes: item.getReceivedBytes() }) })
    })
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:craft-${name}`, sandbox: true, contextIsolation: true, backgroundThrottling: false,
        preload: join(ROOT, 'preload.cjs'), additionalArguments: [`--craft-loader=${spec.loader}`]
      }
    })
    view.setBackgroundColor('#262626')
    this.window.contentView.addChildView(view)
    view.setBounds(show ? RIGHT : { ...RIGHT, x: WINDOW.width - 1, y: WINDOW.height - 1 })
    const entry = { view, ready: null, consoles: [] }
    this.views.set(name, entry)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('console-message', (event) => {
      const text = event.message ?? ''
      if (entry.consoles.length < 200) entry.consoles.push(`${event.level}: ${text.slice(0, 300)}`)
    })
    contents.on('render-process-gone', (_e, details) => this.log(`${name} renderer gone: ${details.reason}`))
    const ready = new Promise((done, fail) => {
      this.waiters.set(name, (info) => { clearTimeout(timer); done(info) })
      const timer = setTimeout(async () => {
        await this.shot(name, `${LABEL}-${name}-stuck.png`).catch(() => {})
        fail(new Error(`${name} did not start in ${timeoutMs} ms; console: ${entry.consoles.slice(-8).join(' | ')}`))
      }, timeoutMs)
    })
    const t0 = Date.now()
    let finishLoad = null
    contents.once('did-finish-load', () => { finishLoad = Date.now() - t0 })
    // The page's process is final once the navigation commits, before its WebAssembly is fetched.
    let commitTicks = null
    contents.once('did-navigate', () => {
      commitTicks = cpuTicks(contents.getOSProcessId())
      if (onCommit) onCommit(contents.getOSProcessId())
    })
    await contents.loadURL(url ?? `craft://${name}/index.html${query}`)
    const info = await ready
    const timing = {
      app: name,
      domLoadedMs: finishLoad,
      wasmFetchedMs: info.wasmEnd != null ? Math.round(info.timeOrigin + info.wasmEnd - t0) : null,
      readyMs: Math.round(info.readyAt - t0),
      firstFrameMs: Math.round(info.frameAt - t0),
      pid: contents.getOSProcessId(),
      // CPU the renderer spent from commit to ready (compile + start-up), less sensitive to machine load than wall time.
      rendererCpuMsToReady: commitTicks == null ? null : (cpuTicks(contents.getOSProcessId()) - commitTicks) * 10,
      loadavg: readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')
    }
    entry.timing = timing
    return timing
  }

  contents(name) { return this.views.get(name).view.webContents }

  /**
   * Show one app over the right side; hide the others. Hide modes: 'hidden' (setVisible(false)),
   * 'removed' (the view taken out of the window), 'parked' (moved off the window's edge, still
   * on screen as far as Chromium knows, the way rocketv1 conceals PhotoCraft).
   */
  show(name, mode = 'hidden') {
    for (const [other, entry] of this.views) {
      if (other !== name) { this.hide(other, mode); continue }
      if (entry.removed) { this.window.contentView.addChildView(entry.view); entry.removed = false }
      entry.view.setVisible(true)
      entry.view.setBounds(RIGHT)
    }
  }

  hide(name, mode = 'hidden') {
    const entry = this.views.get(name)
    if (mode === 'parked') { entry.view.setVisible(true); entry.view.setBounds({ ...RIGHT, x: WINDOW.width - 1, y: WINDOW.height - 1 }) }
    else if (mode === 'removed') { if (!entry.removed) { this.window.contentView.removeChildView(entry.view); entry.removed = true } }
    else entry.view.setVisible(false)
  }

  async close(name) {
    const entry = this.views.get(name)
    if (!entry) return
    if (!entry.removed) this.window.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    this.views.delete(name)
  }

  mem(name) {
    const contents = this.contents(name)
    return procMem(contents.getOSProcessId())
  }

  /** Every Electron process: type, pid, memory. */
  allMem() {
    return app.getAppMetrics().map((m) => ({ type: m.type, name: m.name, ...procMem(m.pid) }))
  }

  async js(name, code) { return this.contents(name).executeJavaScript(code, true) }

  /** Round trip of a trivial script in the page, ms; with a deadline. */
  async ping(name, code = '1', deadlineMs = 15_000) {
    const t0 = performance.now()
    const result = await Promise.race([this.js(name, code).then((v) => 'ok ' + v, (e) => `error: ${e.message}`), sleep(deadlineMs).then(() => 'timeout')])
    return { ms: Math.round(performance.now() - t0), result }
  }

  async cdp(name) {
    const dbg = this.contents(name).debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    return dbg
  }

  async shot(name, file) {
    const image = await this.contents(name).capturePage()
    const path = join(ROOT, 'shots', file)
    writeFileSync(path, image.toPNG())
    return { path, ...image.getSize(), empty: image.isEmpty() }
  }

  async windowShot(file) {
    const image = await this.window.webContents.capturePage()
    writeFileSync(join(ROOT, 'shots', file), image.toPNG())
  }

  click(name, x, y) {
    const c = this.contents(name)
    c.focus()
    c.sendInputEvent({ type: 'mouseMove', x, y })
    c.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    c.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }

  key(name, keyCode, modifiers = []) {
    const c = this.contents(name)
    c.focus()
    c.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    c.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  codeCacheBytes() {
    return { codeCache: dirSize(join(USER_DATA, 'Partitions')) , partitions: readdirSync(join(USER_DATA, 'Partitions'), { withFileTypes: true }).map((d) => ({ name: d.name, codeCacheJs: dirSize(join(USER_DATA, 'Partitions', d.name, 'Code Cache', 'js')), codeCacheWasm: dirSize(join(USER_DATA, 'Partitions', d.name, 'Code Cache', 'wasm')) })) }
  }

  save() {
    const file = join(ROOT, 'results', `${SCENARIO}-${LABEL}.json`)
    writeFileSync(file, JSON.stringify(this.results, null, 2))
    console.log(`[spike] wrote ${file}`)
  }
}

app.whenReady().then(async () => {
  // Shown without taking focus, so a run on the user's display never catches their typing.
  const window = new BrowserWindow({ ...WINDOW, useContentSize: true, show: false, backgroundColor: '#1e1e1e', title: 'Craft web-view spike' })
  window.showInactive()
  window.webContents.debugger.attach('1.3')
  await window.loadFile(join(ROOT, 'shell.html'))
  const host = new Host(window)
  host.results.cgroup = cgroupOf(process.pid)
  host.results.gpu = await app.getGPUInfo('basic').catch((e) => String(e))
  try {
    const { run } = await import(join(ROOT, 'scenarios', `${SCENARIO}.mjs`))
    await run(host, { sleep, procMem, APPS, cgroupOf })
  } catch (error) {
    host.log(`scenario failed: ${error.stack || error}`)
    host.results.error = String(error.stack || error)
  }
  host.results.consoles = Object.fromEntries([...host.views].map(([name, e]) => [name, e.consoles.slice(0, 60)]))
  host.results.downloads = host.downloads ?? []
  host.save()
  app.exit(0)
})
