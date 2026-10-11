// End-to-end check of the Craft dock on a private X display: builds Craft Studio into a temporary
// app folder, starts Xvfb and a window manager, launches Craft Studio with a scratch profile and
// apps folder, and drives `window.craft` the way the renderer does: install GridCraft and
// PhotoCraft for real (from GitHub), show each, switch, hide, resize, check the focus guard, the
// scope limits and that nothing is listed by the window manager, then quit and check that every
// app and scope is gone. Screenshots and a JSON record go to the evidence folder.
//
//   node scripts/craft-e2e.mjs <evidence dir> [--wm=openbox|mutter|none] [--display=:87] [--rest] [--keep-apps=<dir>]
//
// --rest also waits out the two idle minutes to see an app come to rest. --keep-apps reuses an
// apps folder between runs (installs are then adopted, not downloaded). Never run it on the
// user's display: it moves the pointer and types.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const evidence = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(tmpdir(), 'craft-e2e-evidence'))
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const wm = option('wm', 'openbox')
const display = option('display', ':87')
const keepApps = option('keep-apps', null)
const waitRest = args.includes('--rest')
const work = await mkdtemp(join(tmpdir(), 'craft-e2e-'))
const appRoot = join(work, 'app')
const profile = join(work, 'profile')
const appsDir = keepApps ? resolve(keepApps) : join(work, 'apps')
const record = { display, wm, started: new Date().toISOString(), steps: [] }
const children = []
let application = null
const t0 = Date.now()

const say = (message) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${message}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const x = (command, ...rest) => execFileSync(command, rest, { env: { ...process.env, DISPLAY: display }, encoding: 'utf8', timeout: 20_000 }).trim()
const shot = async (name) => {
  const file = join(evidence, `${name}.png`)
  x('import', '-window', 'root', file)
  say(`screenshot ${name}.png`)
  return file
}
async function step(name, work) {
  const started = Date.now()
  try {
    const result = await work()
    record.steps.push({ name, ok: true, ms: Date.now() - started, result })
    say(`ok   ${name} (${Date.now() - started} ms)${result === undefined ? '' : ` ${JSON.stringify(result).slice(0, 300)}`}`)
    return result
  } catch (error) {
    record.steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) })
    say(`FAIL ${name}: ${String(error?.message ?? error).slice(0, 400)}`)
    return undefined
  }
}

function start(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, ...options })
  child.stderr?.on('data', () => {})
  children.push(child)
  return child
}

async function waitFor(check, ms = 15_000, label = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await check()) return true } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function startDisplay() {
  const number = display.slice(1)
  if (existsSync(`/tmp/.X11-unix/X${number}`)) throw new Error(`Display ${display} is in use; pick another with --display.`)
  start('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'])
  await waitFor(() => existsSync(`/tmp/.X11-unix/X${number}`), 10_000, 'Xvfb')
  if (wm === 'openbox') {
    // openbox 3.6.1 unpacked without installing (the native-dock spike's /tmp/nd-wm).
    const base = '/tmp/nd-wm/root'
    start(`${base}/usr/bin/openbox`, ['--sm-disable'], { env: { ...process.env, DISPLAY: display, LD_LIBRARY_PATH: `${base}/usr/lib/x86_64-linux-gnu`, XDG_DATA_DIRS: `${base}/usr/share:/usr/share`, XDG_CONFIG_DIRS: `${base}/etc/xdg:/etc/xdg` } })
  } else if (wm === 'mutter') {
    // A real gnome-shell (mutter) on the private display, with its own HOME and session bus, as
    // in spikes/native-dock/live-mutter.
    const home = join(work, 'gshome')
    await mkdir(join(home, 'run'), { recursive: true, mode: 0o700 })
    start('env', ['-i', 'PATH=/usr/bin:/bin', `HOME=${home}`, `XDG_RUNTIME_DIR=${home}/run`, `DISPLAY=${display}`, 'XDG_SESSION_TYPE=x11',
      'dbus-run-session', '--', 'gnome-shell', '--x11', '--replace'])
  }
  if (wm !== 'none') await waitFor(() => /_NET_SUPPORTING_WM_CHECK\(WINDOW\)/.test(x('xprop', '-root', '_NET_SUPPORTING_WM_CHECK')), 30_000, `${wm} to start`)
  if (wm === 'mutter') {
    // gnome-shell opens in the Activities overview; Escape closes it so clicks reach windows.
    await sleep(3000)
    x('xdotool', 'key', 'Escape')
    await sleep(1000)
  }
  say(`display ${display} ready with ${wm}`)
}

async function build() {
  await mkdir(appRoot, { recursive: true })
  await symlink(join(root, 'node_modules'), join(appRoot, 'node_modules'), 'dir')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  execFileSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '--outDir', join(appRoot, 'out')], { cwd: root, env, stdio: 'inherit' })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName, version: manifest.version, type: 'module', main: 'out/main/index.js' }))
}

/** Our scopes and processes, to check the end state. */
function scopes() {
  try {
    return x('systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', 'craft-studio-*').split('\n').filter((line) => line.includes(`-${application?.process().pid ?? 'x'}-`) || line.includes('craft-studio-')).map((line) => line.split(/\s+/)[0]).filter(Boolean)
  } catch { return [] }
}
function scopeProps(unit) {
  const out = x('systemctl', '--user', 'show', `${unit}.scope`, '-p', 'MemoryHigh', '-p', 'CPUWeight', '-p', 'ActiveState')
  return Object.fromEntries(out.split('\n').map((line) => line.split('=')))
}
function unitOf(id) {
  return scopes().find((unit) => unit.startsWith(`craft-studio-${id}-`))?.replace(/\.scope$/, '') ?? null
}
function appPid(id) {
  // pgrep exits 1 when nothing matches, which is the answer we often want.
  try { return Number(x('pgrep', '-n', '-f', `${appsDir}/apps/${id}/.*/bin/${id} `) || 0) } catch { return 0 }
}
function portOf(id) {
  const line = x('pgrep', '-a', '-f', `${appsDir}/apps/${id}/.*/bin/${id} `)
  return Number(/--control (\d+)/.exec(line)?.[1] ?? 0)
}
function clientList() { return x('xprop', '-root', '_NET_CLIENT_LIST') }
function treeOf(wid) { return x('xwininfo', '-children', '-id', wid) }
function electronXid() {
  const ids = x('xdotool', 'search', '--pid', String(application.process().pid)).split('\n')
  for (const id of ids) {
    try { if (/Map State: IsViewable/.test(x('xwininfo', '-id', id)) && /Width: (1[0-9]{3})/.test(x('xwininfo', '-id', id))) return Number(id) } catch { /* gone */ }
  }
  return Number(ids[0])
}
function windowOfPid(pid) {
  // The app's docked window: a child of Electron's window whose creator is the app (XRes).
  const out = x('xwininfo', '-children', '-id', String(electronXid()))
  return [...out.matchAll(/^\s+(0x[0-9a-f]+) .*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/gm)].map((m) => ({ id: m[1], width: Number(m[2]), height: Number(m[3]), x: Number(m[4]), y: Number(m[5]) }))
}

/** One raw request on an app's control channel (GridCraft: no token), first reply line back. */
function control(port, request, timeoutMs = 20_000) {
  return new Promise((done, fail) => {
    const socket = createConnection(port, '127.0.0.1')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); fail(new Error(`no reply within ${timeoutMs} ms`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); fail(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, ...request }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const line = buffer.split('\n').find((entry) => entry.trim())
      if (line && buffer.includes('\n')) { clearTimeout(timer); socket.destroy(); done(JSON.parse(line)) }
    })
  })
}

async function main() {
  await mkdir(evidence, { recursive: true })
  await startDisplay()
  await step('build', build)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CRAFT_|ROCKET_|ELECTRON_)/.test(name)))
  Object.assign(env, { DISPLAY: display, CRAFT_USER_DATA: profile, CRAFT_APPS_DIR: appsDir, CRAFT_AUTO_COMMIT: '0' })
  delete env.WAYLAND_DISPLAY
  // UI-test mode: every provider is the controlled stand-in, so nothing typed here can ever reach
  // a real model, and the page's network is held to a loopback origin. Main's own downloads (the
  // installs) do not go through Chromium and are not affected.
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
  const origin = createServer((_req, res) => res.end('craft-e2e')).listen(0, '127.0.0.1')
  await new Promise((done) => origin.once('listening', done))
  children.push({ pid: 0, close: () => origin.close() })
  Object.assign(env, { CRAFT_UI_TEST: '1', CRAFT_UI_TEST_ORIGIN: `http://127.0.0.1:${origin.address().port}/` })
  application = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [appRoot, '--no-sandbox'], cwd: work, env, timeout: 60_000 })
  application.process().stderr?.on('data', (chunk) => { if (/craft|x11|error/i.test(String(chunk))) process.stderr.write(`[electron] ${chunk}`) })
  const shell = await application.firstWindow()
  await shell.waitForFunction(() => !!window.craft, null, { timeout: 30_000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1440, height: 900 }))
  await sleep(1500)
  if (wm === 'mutter') {
    // Activating a window leaves gnome-shell's startup overview, as spikes/native-dock/live-mutter did.
    x('xdotool', 'windowactivate', String(electronXid()))
    await sleep(1200)
    let active = 0
    try { active = Number(x('xdotool', 'getactivewindow')) } catch { /* none active: still in the overview */ }
    if (active !== electronXid()) x('xdotool', 'key', 'Escape')
    await sleep(800)
  }
  await shell.evaluate(() => {
    window.__craftStates = []
    window.craft.onState((state) => window.__craftStates.push({ ...state, at: Date.now() }))
  })
  const bounds = { x: 560, y: 48, width: 860, height: 760 }
  const call = (method, ...params) => shell.evaluate(([name, values]) => window.craft[name](...values), [method, params])
  const states = (id) => shell.evaluate((app) => window.__craftStates.filter((state) => state.id === app), id)

  await step('catalog lists twelve apps, none installed', async () => {
    const apps = await call('catalog')
    if (apps.length !== 12) throw new Error(`catalog has ${apps.length} apps`)
    return apps.map((app) => `${app.shortName}:${app.installed ? app.installedVersion : '-'}:${Math.round(app.sizeBytes / 1e6)}MB`)
  })
  await shot('00-shelf')
  for (const id of ['gridcraft', 'photocraft']) {
    await step(`install ${id} (real download)`, async () => {
      const started = Date.now()
      await call('install', id)
      const progress = (await states(id)).filter((state) => state.installState === 'installing').length
      return { seconds: (Date.now() - started) / 1000, progressEvents: progress, last: (await states(id)).at(-1) }
    })
  }
  await step('catalog after installs', async () => (await call('catalog')).filter((app) => app.installed).map((app) => ({ id: app.id, version: app.installedVersion, sizeBytes: app.sizeBytes })))

  await step('show GridCraft (cold start)', async () => {
    const started = Date.now()
    await call('show', 'gridcraft', bounds, work)
    const ms = Date.now() - started
    await sleep(1500)
    return { ms, run: (await states('gridcraft')).map((state) => state.run).join('>'), scope: scopeProps(unitOf('gridcraft')) }
  })
  await shot('01-grid-shown')
  await step('GridCraft is a child of Electron, never listed by the WM', async () => {
    const children = windowOfPid()
    const list = clientList()
    return { electron: `0x${electronXid().toString(16)}`, children, clientList: list }
  })

  await step('show PhotoCraft (cold start), GridCraft parked', async () => {
    const started = Date.now()
    await call('show', 'photocraft', bounds, work)
    const ms = Date.now() - started
    await sleep(2000)
    return { ms, grid: scopeProps(unitOf('gridcraft')), photo: scopeProps(unitOf('photocraft')), children: windowOfPid() }
  })
  await shot('02-photo-shown')
  await step('GridCraft answers a screenshot while parked (redirected)', async () => {
    const started = Date.now()
    const file = join(evidence, 'grid-own-screenshot-while-parked.png')
    const reply = await control(portOf('gridcraft'), { method: 'ui.screenshot', params: { path: file } }, 20_000)
    return { ms: Date.now() - started, ok: reply.ok ?? !reply.error, file: existsSync(file) ? file : null, error: reply.error }
  })

  await step('switch back to GridCraft (warm)', async () => {
    const started = Date.now()
    await call('show', 'gridcraft', bounds, work)
    return { ms: Date.now() - started }
  })
  await sleep(800)
  await shot('03-grid-again')

  await step('focus guard: a click gives the app the keyboard; a click on the page takes it back', async () => {
    // Where the X server has the window, not where Electron thinks it put it: a WM may move it
    // (gnome-shell keeps windows below its top bar).
    const reported = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
    const info = x('xwininfo', '-id', String(electronXid()))
    const win = { x: Number(/Absolute upper-left X:\s+(-?\d+)/.exec(info)[1]), y: Number(/Absolute upper-left Y:\s+(-?\d+)/.exec(info)[1]) }
    const focus = () => x('xdotool', 'getwindowfocus', '-f')
    // A cell near the top left of the sheet, then type into it.
    x('xdotool', 'mousemove', String(win.x + bounds.x + 140), String(win.y + bounds.y + 200), 'click', '1')
    await sleep(500)
    const afterAppClick = focus()
    const appWindow = windowOfPid().find((child) => child.x >= 0)?.id
    // Type only when the app holds the keyboard, and never press Return: these keys must not be
    // able to send anything anywhere else.
    const typedIntoApp = !!appWindow && Number(afterAppClick) === Number(appWindow)
    if (typedIntoApp) x('xdotool', 'type', '--delay', '120', 'docked')
    await sleep(400)
    // Click the chat's composer, rest the pointer over the app, and type: the keys must reach the page.
    const composer = await shell.evaluate(() => {
      const box = document.querySelector('textarea')?.getBoundingClientRect()
      return box ? { x: box.left + 20, y: box.top + 10 } : null
    })
    let chat = null
    let afterPageClick = null
    if (composer) {
      x('xdotool', 'mousemove', String(win.x + Math.round(composer.x)), String(win.y + Math.round(composer.y)), 'click', '1')
      await sleep(400)
      afterPageClick = focus()
      x('xdotool', 'mousemove', String(win.x + bounds.x + 300), String(win.y + bounds.y + 300))
      await sleep(200)
      x('xdotool', 'type', '--delay', '120', 'to-chat')
      await sleep(400)
      chat = await shell.evaluate(() => document.querySelector('textarea')?.value ?? null)
    }
    const hex = (value) => value ? `0x${Number(value).toString(16)}` : value
    if (!typedIntoApp) throw new Error(`the click did not give the app the keyboard (focus ${hex(afterAppClick)}, app ${appWindow})`)
    if (chat !== 'to-chat') throw new Error(`keys typed with the pointer over the app did not reach the chat (it holds ${JSON.stringify(chat)})`)
    return { reported: { x: reported.x, y: reported.y }, actual: win, electron: hex(electronXid()), app: appWindow, afterAppClick: hex(afterAppClick), afterPageClick: hex(afterPageClick), chat, children: windowOfPid() }
  })
  await shot('04-grid-typed')

  await step('hide (shelf shown): the app is parked', async () => {
    await call('hide')
    await sleep(800)
    return { grid: scopeProps(unitOf('gridcraft')), children: windowOfPid(), run: (await states('gridcraft')).at(-1)?.run }
  })
  await shot('05-hidden')

  await step('resize the window and refit PhotoCraft', async () => {
    await call('show', 'photocraft', bounds, work)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1200, height: 780 }))
    await sleep(600)
    const next = { x: 560, y: 48, width: 620, height: 640 }
    const started = Date.now()
    await call('setBounds', next)
    const ms = Date.now() - started
    await sleep(800)
    return { ms, children: windowOfPid() }
  })
  await shot('06-photo-resized')

  if (waitRest) {
    await step('GridCraft comes to rest after two idle minutes', async () => {
      const unit = unitOf('gridcraft')
      const before = scopeProps(unit)
      await sleep(125_000)
      const after = scopeProps(unit)
      const memory = Number(readFileSyncSafe(`/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${unit}.scope/memory.current`))
      return { before, after, memoryCurrent: memory, run: (await states('gridcraft')).at(-1)?.run }
    })
    await step('show the resting GridCraft (limits lifted first)', async () => {
      const started = Date.now()
      await call('show', 'gridcraft', bounds, work)
      return { ms: Date.now() - started, scope: scopeProps(unitOf('gridcraft')) }
    })
    await sleep(800)
    await shot('07-grid-after-rest')
  }

  await step('remove GridCraft: stops it, deletes it, keeps PhotoCraft', async () => {
    await call('hide')
    await call('remove', 'gridcraft')
    await sleep(500)
    return { gridDir: existsSync(join(appsDir, 'apps', 'gridcraft')), gridPid: appPid('gridcraft'), last: (await states('gridcraft')).at(-1), installed: (await call('catalog')).filter((app) => app.installed).map((app) => app.id) }
  })
  await step('state events seen', async () => {
    const all = await shell.evaluate(() => window.__craftStates)
    return all.filter((state) => state.installState !== 'installing').map((state) => `${state.id}:${state.installState}:${state.run}${state.error ? `:${state.error}` : ''}`)
  })
}

function readFileSyncSafe(path) {
  try { return execFileSync('cat', [path], { encoding: 'utf8' }).trim() } catch { return '' }
}

async function finish() {
  if (application) {
    const pid = application.process().pid
    await step('quit Craft Studio: every app and scope stops', async () => {
      const before = scopes()
      await application.close().catch(() => {})
      await sleep(4500)
      return { scopesBefore: before, scopesAfter: scopes(), appsLeft: x('bash', '-c', `pgrep -af '${appsDir}/apps' || true`), electronAlive: (() => { try { process.kill(pid, 0); return true } catch { return false } })() }
    })
  }
  // The dock's own log lines (X11 helper included) from the scratch profile's journal.
  try {
    const lines = (await readFile(join(profile, 'journal.jsonl'), 'utf8')).split('\n').filter((line) => line.includes('"source":"craft"'))
    await writeFile(join(evidence, `journal-${wm}.jsonl`), lines.join('\n') + '\n')
  } catch { /* no journal */ }
  for (const child of children.reverse()) {
    if (child.close) { child.close(); continue }
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  }
  await sleep(1500)
  for (const child of children) {
    if (child.close) continue
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  }
  if (wm === 'mutter') {
    // gnome-shell's helpers (gvfs and friends) carry its private HOME; stop any that outlived it.
    try { execFileSync('bash', ['-c', `for p in $(pgrep -u $(id -u)); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx 'HOME=${work}/gshome' && kill $p; done; true`]) } catch { /* none */ }
    try { execFileSync('bash', ['-c', `grep -o '${work}/gshome[^ ]*' /proc/mounts | xargs -r -n1 fusermount3 -u; true`]) } catch { /* none */ }
  }
  record.finished = new Date().toISOString()
  await writeFile(join(evidence, `e2e-${wm}.json`), JSON.stringify(record, null, 2))
  // A kept apps folder lives outside the work folder, so the work folder always goes.
  await rm(work, { recursive: true, force: true }).catch(() => {})
  say(`done: ${record.steps.filter((s) => s.ok).length}/${record.steps.length} steps ok; record in ${join(evidence, `e2e-${wm}.json`)}`)
}

try {
  await main()
} catch (error) {
  record.fatal = String(error?.stack ?? error)
  say(`FATAL ${error?.message ?? error}`)
} finally {
  await finish()
}
