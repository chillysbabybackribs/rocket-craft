// End-to-end check of the craft_* model tools on a private X display: builds Craft Studio into a
// temporary folder, launches it in UI-test mode (every provider is the controlled stand-in, so no
// real model receives anything) with a scratch profile and apps folder, installs GridCraft and
// PhotoCraft for real, makes a chat in a scratch folder with one controlled message, and then calls
// the tools the way a provider does: JSON-RPC `tools/call` on the app's MCP tool channel, under that
// chat. Tool results, the images they return, root-window captures and a JSON record go to the
// evidence folder.
//
//   node scripts/craft-tools-e2e.mjs <evidence dir> [--display=:94] [--keep-apps=<dir>] [--wm=openbox|none]
//
// Never run it on the user's display: it moves windows and clicks.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const evidence = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(tmpdir(), 'craft-tools-e2e'))
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const display = option('display', ':94')
const wm = option('wm', 'openbox')
const keepApps = option('keep-apps', null)
const work = await mkdtemp(join(tmpdir(), 'craft-tools-e2e-'))
const appRoot = join(work, 'app')
const profile = join(work, 'profile')
const appsDir = keepApps ? resolve(keepApps) : join(work, 'apps')
const files = join(work, 'chat-folder')
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
  say(`display capture ${name}.png`)
  return file
}

async function step(name, work, { expectError = false } = {}) {
  const started = Date.now()
  try {
    const result = await work()
    record.steps.push({ name, ok: true, ms: Date.now() - started, result })
    say(`ok   ${name} (${Date.now() - started} ms)${result === undefined ? '' : ` ${JSON.stringify(result).slice(0, 240)}`}`)
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
    await waitFor(() => /_NET_SUPPORTING_WM_CHECK\(WINDOW\)/.test(x('xprop', '-root', '_NET_SUPPORTING_WM_CHECK')), 30_000, 'openbox to start')
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

function scopes() {
  try {
    return x('systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', 'craft-studio-*').split('\n').map((line) => line.split(/\s+/)[0]).filter((unit) => unit && unit.includes(`-${application?.process().pid ?? 'x'}-`))
  } catch { return [] }
}
function scopeProps(id) {
  const unit = scopes().find((entry) => entry.startsWith(`craft-studio-${id}-`))
  if (!unit) return null
  const out = x('systemctl', '--user', 'show', unit, '-p', 'MemoryHigh', '-p', 'CPUWeight', '-p', 'ActiveState')
  return Object.fromEntries(out.split('\n').map((line) => line.split('=')))
}

// ---- The tool channel ------------------------------------------------------------------------------

let channel = null
let rpc = 0
let chatId = null

async function mcp(method, params) {
  const response = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/claude/${encodeURIComponent(chatId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params })
  })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/** A tool call; images are saved beside the record and replaced by their file names. */
async function tool(name, args, label = name) {
  const started = Date.now()
  const result = await mcp('tools/call', { name, arguments: args })
  const content = []
  let n = 0
  for (const part of result.content ?? []) {
    if (part.type === 'image') {
      const file = join(evidence, `${label.replace(/[^\w.-]+/g, '-')}${n++ ? `-${n}` : ''}.png`)
      await writeFile(file, Buffer.from(part.data, 'base64'))
      content.push({ type: 'image', file, bytes: Buffer.from(part.data, 'base64').length })
    } else content.push({ type: 'text', text: part.text.length > 4000 ? `${part.text.slice(0, 4000)}… (${part.text.length} chars)` : part.text })
  }
  return { tool: name, args, ms: Date.now() - started, isError: !!result.isError, content }
}

function must(result, check = (r) => !r.isError) {
  if (!check(result)) throw new Error(`unexpected result: ${JSON.stringify(result).slice(0, 600)}`)
  return result
}
const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')

async function main() {
  await mkdir(evidence, { recursive: true })
  await mkdir(files, { recursive: true })
  await startDisplay()
  await step('build', build)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CRAFT_|ROCKET_|ELECTRON_)/.test(name)))
  Object.assign(env, { DISPLAY: display, CRAFT_USER_DATA: profile, CRAFT_APPS_DIR: appsDir, CRAFT_AUTO_COMMIT: '0' })
  delete env.WAYLAND_DISPLAY
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
  const origin = createServer((_req, res) => res.end('craft-tools-e2e')).listen(0, '127.0.0.1')
  await new Promise((done) => origin.once('listening', done))
  children.push({ pid: 0, close: () => origin.close() })
  Object.assign(env, { CRAFT_UI_TEST: '1', CRAFT_UI_TEST_ORIGIN: `http://127.0.0.1:${origin.address().port}/` })
  application = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [appRoot, '--no-sandbox'], cwd: work, env, timeout: 60_000 })
  application.process().stderr?.on('data', (chunk) => { if (/craft|x11|error/i.test(String(chunk))) process.stderr.write(`[electron] ${chunk}`) })
  let shell = await application.firstWindow()
  await shell.waitForFunction(() => !!window.craft, null, { timeout: 30_000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1440, height: 900 }))
  const craftCall = (method, ...params) => shell.evaluate(([name, values]) => window.craft[name](...values), [method, params])

  for (const id of ['gridcraft', 'photocraft']) {
    await step(`install ${id} (pinned release, checksum verified)`, async () => {
      const started = Date.now()
      await craftCall('install', id)
      return { seconds: (Date.now() - started) / 1000 }
    })
  }

  await step('a chat in a scratch folder, made by one controlled UI-test message', async () => {
    // New chats start in the saved folder; the reload makes the store read it.
    await shell.evaluate((folder) => localStorage.setItem('rocket.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('rocket.prefs') ?? '{}'), cwd: folder })), files)
    await shell.reload()
    await shell.waitForFunction(() => !!window.craft && !!window.rocketMap, null, { timeout: 30_000 })
    const composer = shell.locator('textarea').first()
    await composer.fill('UI check: good evening')
    await composer.press('Enter')
    await waitFor(async () => !!(await shell.evaluate(() => window.rocketMap.where().panes[0]?.chatId)), 20_000, 'the chat')
    chatId = await shell.evaluate(() => window.rocketMap.where().panes[0].chatId)
    channel = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8'))
    await waitFor(() => existsSync(join(profile, 'ui-request.json')), 20_000, 'the controlled turn')
    const sent = JSON.parse(await readFile(join(profile, 'ui-request.json'), 'utf8'))
    return { chatId, cwd: sent.cwd, toolChannelPort: channel.port, craftLine: /<craft-apps>.*<\/craft-apps>/.exec(sent.input)?.[0] ?? null }
  })
  await shell.evaluate(() => {
    window.__craftStates = []
    window.craft.onState((state) => window.__craftStates.push({ ...state, at: Date.now() }))
  })
  const runs = (id) => shell.evaluate((app) => window.__craftStates.filter((state) => state.id === app).map((state) => state.run), id)

  await step('tools/list has the nine craft tools, each naming the app', async () => {
    const list = (await mcp('tools/list', {})).tools.filter((entry) => entry.name.startsWith('craft_'))
    if (list.length !== 9) throw new Error(`${list.length} craft tools`)
    return list.map((entry) => ({ name: entry.name, required: entry.inputSchema.required ?? [] }))
  })
  await step('craft_apps before anything runs', async () => must(await tool('craft_apps', {}, '01-craft_apps')))
  await step('craft_run on an app that is not installed is refused, nothing starts', async () => {
    const result = await tool('craft_run', { app: 'vectorcraft', command: 'document.new' }, '02-not-installed')
    must(result, (r) => r.isError && /not installed\. Ask the user to install it from the app shelf/.test(textOf(r)))
    return { ...result, vectorScope: scopeProps('vectorcraft') }
  })
  await step('craft_show on an app that is not installed is refused', async () => must(await tool('craft_show', { app: 'cadcraft' }, '03-show-not-installed'), (r) => r.isError))
  await step('bad arguments are refused before anything runs', async () => must(await tool('craft_run', { app: 'gridcraft', command: 'cell.set', params: 'A1' }, '04-bad-args'), (r) => r.isError && /params must be an object/.test(textOf(r))))

  // GridCraft: driven by a model before anyone shows it, so it starts parked.
  await step('GridCraft: craft_run range.setValues starts it parked and writes a range', async () => {
    const result = must(await tool('craft_run', { app: 'gridcraft', command: 'range.setValues', params: { range: 'A1:B5', values: [['Month', 'Sales'], ['Jan', 120], ['Feb', 180], ['Mar', 150], ['Apr', 210]] } }, '10-grid-setValues'))
    return { ...result, runs: await runs('gridcraft'), scope: scopeProps('gridcraft') }
  })
  await step('GridCraft: craft_commands search "chart"', async () => must(await tool('craft_commands', { app: 'gridcraft', search: 'insert chart' }, '11-grid-commands')))
  await step('GridCraft: craft_run insert.chart', async () => must(await tool('craft_run', { app: 'gridcraft', command: 'insert.chart', params: { range: 'A1:B5', type: 'column', title: 'Sales', at: 'D2' } }, '12-grid-chart')))
  await step('GridCraft: craft_run sheet.read (a control method)', async () => must(await tool('craft_run', { app: 'gridcraft', command: 'sheet.read', params: { range: 'A1:B5' } }, '13-grid-read')))
  await step('GridCraft: craft_inspect', async () => must(await tool('craft_inspect', { app: 'gridcraft' }, '14-grid-inspect')))
  await step('GridCraft: craft_screenshot while parked (never shown)', async () => {
    const result = must(await tool('craft_screenshot', { app: 'gridcraft' }, '15-grid-screenshot-parked'))
    return { ...result, runs: await runs('gridcraft') }
  })
  await step('GridCraft: two calls at once run one after the other', async () => {
    const [a, b] = await Promise.all([
      tool('craft_batch', { app: 'gridcraft', steps: [{ command: 'cell.set', params: { cell: 'A7', input: 'first' } }, { command: 'cell.set', params: { cell: 'B7', input: '=SUM(B2:B5)' } }] }, '16-grid-batch'),
      tool('craft_run', { app: 'gridcraft', command: 'cell.set', params: { cell: 'A8', input: 'second' } }, '16-grid-run')
    ])
    must(a); must(b)
    const read = must(await tool('craft_run', { app: 'gridcraft', command: 'sheet.read', params: { range: 'A7:B8' } }, '16-grid-read'))
    return { batch: a, run: b, read }
  })
  await step('GridCraft: craft_save book.xlsx and data.csv relative to the chat folder', async () => {
    const xlsx = must(await tool('craft_save', { app: 'gridcraft', path: 'out/book.xlsx' }, '17-grid-save-xlsx'))
    const csv = must(await tool('craft_save', { app: 'gridcraft', path: 'out/data', format: 'csv' }, '17-grid-save-csv'))
    return { xlsx, csv, files: { xlsx: (await stat(join(files, 'out/book.xlsx'))).size, csv: await readFile(join(files, 'out/data.csv'), 'utf8') } }
  })
  await step('GridCraft: craft_open the saved workbook', async () => must(await tool('craft_open', { app: 'gridcraft', path: 'out/book.xlsx' }, '18-grid-open')))
  await step('GridCraft: craft_show puts it on the right side', async () => {
    const result = must(await tool('craft_show', { app: 'gridcraft' }, '19-grid-show'))
    await sleep(1500)
    return { ...result, runs: await runs('gridcraft'), scope: scopeProps('gridcraft') }
  })
  await shot('20-display-grid-shown')

  // PhotoCraft: shown first, so it starts with the chat's folder as its only read/write root.
  await step('PhotoCraft: craft_show starts it with the chat folder as its root', async () => {
    const result = must(await tool('craft_show', { app: 'photocraft' }, '30-photo-show'))
    await sleep(2500)
    return { ...result, runs: await runs('photocraft'), photo: scopeProps('photocraft'), grid: scopeProps('gridcraft') }
  })
  await step('PhotoCraft: craft_commands "paint bucket"', async () => must(await tool('craft_commands', { app: 'photocraft', search: 'paint bucket' }, '31-photo-commands')))
  await step('PhotoCraft: craft_batch new document, colours, fill, brush stroke', async () => must(await tool('craft_batch', {
    app: 'photocraft',
    steps: [
      { command: 'file.new', params: { width: 800, height: 500, background: 'white', name: 'Tools e2e' } },
      { command: 'tools.setColors', params: { foreground: '#1f6feb', background: '#ffffff' } },
      { command: 'paint.bucket', params: { x: 10, y: 10, color: '#ffd166' } },
      { command: 'layer.new.layer', params: { name: 'Ink' } },
      { command: 'paint.stroke', params: { points: [[100, 400, 1], [250, 150, 1], [400, 380, 1], [550, 120, 1], [700, 360, 1]], size: 40, color: '#1f6feb' } }
    ]
  }, '32-photo-batch')))
  await step('PhotoCraft: craft_inspect', async () => must(await tool('craft_inspect', { app: 'photocraft' }, '33-photo-inspect')))
  await step('PhotoCraft: craft_screenshot while shown', async () => must(await tool('craft_screenshot', { app: 'photocraft', maxWidth: 800 }, '34-photo-screenshot-shown')))
  await shot('35-display-photo-shown')
  await step('switch back to GridCraft: PhotoCraft is parked', async () => {
    must(await tool('craft_show', { app: 'gridcraft' }, '36-grid-show-again'))
    await sleep(1500)
    return { photoRuns: await runs('photocraft'), photo: scopeProps('photocraft') }
  })
  await shot('37-display-grid-shown-photo-parked')
  await step('PhotoCraft: craft_screenshot while parked', async () => {
    const result = must(await tool('craft_screenshot', { app: 'photocraft' }, '38-photo-screenshot-parked'))
    return { ...result, photoRuns: await runs('photocraft') }
  })
  await step('PhotoCraft: craft_save a PNG into the chat folder while parked', async () => {
    const result = must(await tool('craft_save', { app: 'photocraft', path: 'out/photo.png' }, '39-photo-save'))
    const bytes = await readFile(join(files, 'out/photo.png'))
    await writeFile(join(evidence, '39-photo-saved-file.png'), bytes)
    return { ...result, saved: { bytes: bytes.length, png: bytes.subarray(1, 4).toString() === 'PNG' } }
  })
  await step('PhotoCraft: a save outside its folder is refused before it reaches the app', async () => must(await tool('craft_save', { app: 'photocraft', path: join(work, 'elsewhere.png') }, '40-photo-save-outside'), (r) => r.isError && /may only read and write inside/.test(textOf(r))))
  await step('PhotoCraft: craft_run app.quit is refused', async () => must(await tool('craft_run', { app: 'photocraft', command: 'app.quit' }, '41-photo-quit'), (r) => r.isError))
  await step('PhotoCraft: a call after 35 s idle (it drops idle connections at 30 s) reconnects and works', async () => {
    await sleep(35_000)
    return must(await tool('craft_inspect', { app: 'photocraft', what: 'ui' }, '42-photo-after-idle'))
  })
  await step('craft_apps with both running', async () => must(await tool('craft_apps', {}, '50-craft_apps')))
  await step('the situation line ahead of the next message', async () => {
    const composer = shell.locator('textarea').first()
    await composer.fill('UI check: good evening')
    await composer.press('Enter')
    await sleep(4000)
    const sent = JSON.parse(await readFile(join(profile, 'ui-request.json'), 'utf8'))
    return { craftLine: /<craft-apps>.*<\/craft-apps>/.exec(sent.input)?.[0] ?? null }
  })
  await step('state events seen', async () => shell.evaluate(() => window.__craftStates.map((state) => `${state.id}:${state.installState}:${state.run}${state.error ? `:${state.error}` : ''}`)))
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
  try {
    const lines = (await readFile(join(profile, 'journal.jsonl'), 'utf8')).split('\n').filter((line) => /craft/i.test(line))
    await writeFile(join(evidence, 'journal.jsonl'), lines.join('\n') + '\n')
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
  record.finished = new Date().toISOString()
  await writeFile(join(evidence, 'e2e-tools.json'), JSON.stringify(record, null, 2))
  await rm(work, { recursive: true, force: true }).catch(() => {})
  say(`done: ${record.steps.filter((s) => s.ok).length}/${record.steps.length} steps ok; record in ${join(evidence, 'e2e-tools.json')}`)
}

try {
  await main()
} catch (error) {
  record.fatal = String(error?.stack ?? error)
  say(`FATAL ${error?.message ?? error}`)
} finally {
  await finish()
}
