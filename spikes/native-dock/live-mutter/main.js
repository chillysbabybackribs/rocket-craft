// Native-dock spike: an Electron window with a placeholder chat on the left, a right
// region and a dock of two buttons. A button starts its Craft app in its own systemd
// scope, finds the app's X window by _NET_WM_PID and reparents it into this window
// at the right region's bounds (xdock.py does the X calls). Switching parks the other
// app out of view by moving it, never unmapping it.
//
// SPIKE_MODE=overlay keeps the app a borderless top-level over the region instead.
// A JSON-lines control socket (run/ctl.sock) lets drive.mjs script and time all of it.
//
// live-mutter copy: scratch userData (SPIKE_USERDATA), a window position (SPIKE_X/Y), and
// open({app, early}) where early = none | skip | early tells xdock.py's root watcher what to
// do with the app's top-level the moment it is created (see xdock.py op_watch).
const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')
const crypto = require('crypto')

const HERE = __dirname
const RUN = path.join(HERE, 'run')
const BIN = process.env.CRAFT_BIN_ROOT || '/tmp/craft-measure.b2Tv/x'
const MODE = process.env.SPIKE_MODE || 'reparent'
fs.mkdirSync(RUN, { recursive: true })

const APPS = {
  photo: {
    bin: `${BIN}/photocraft-0.7.0-linux-x86_64/bin/photocraft`,
    cli: `${BIN}/photocraft-0.7.0-linux-x86_64/bin/photocraft-cli`,
    port: 47711,
    token: true,
    args: (a) => ['--control', String(a.port), '--control-token-file', a.tokenFile],
    bridge: (a) => ['mcp', '--bridge', `127.0.0.1:${a.port}`, '--control-token-file', a.tokenFile],
    inspect: 'ui_inspect',
  },
  grid: {
    bin: `${BIN}/gridcraft-0.5.0-linux-x86_64/bin/gridcraft`,
    cli: `${BIN}/gridcraft-0.5.0-linux-x86_64/bin/gridcraft-cli`,
    port: 47712,
    token: false,
    args: (a) => ['--control', String(a.port)],
    bridge: (a) => ['mcp', '--connect', String(a.port)],
    inspect: 'inspect_workbook',
  },
}

let win
let stage = { x: 0, y: 0, w: 0, h: 0 }
let shown = null
const running = {}

// xdock.py: one Xlib connection each, JSON lines. `x` places windows; `xf` only
// reads pixels, so a frame wait never blocks a placement.
function xdock() {
  const p = spawn('python3', ['-I', path.join(HERE, 'xdock.py')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiters = new Map()
  let seq = 0
  let buf = ''
  p.stdout.on('data', (b) => {
    buf += b
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      const w = waiters.get(msg.id)
      waiters.delete(msg.id)
      if (w) msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error))
    }
  })
  const call = (op, args = {}) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      p.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }
  call.proc = p
  return call
}
const x = xdock()
const xf = xdock()
const REDIRECT = process.env.SPIKE_REDIRECT || 'park'

function sh(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
}

function electronXid() {
  const h = win.getNativeWindowHandle()
  return h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0)
}

async function stageOnRoot() {
  const g = await x('geom', { wid: electronXid() })
  return { rx: g.rootX + stage.x, ry: g.rootY + stage.y, w: stage.w, h: stage.h }
}

function log(...a) {
  console.log(new Date().toISOString(), ...a)
}

async function launch(name, early = process.env.SPIKE_EARLY || 'none') {
  const spec = APPS[name]
  const a = { port: spec.port, name }
  if (spec.token) {
    a.tokenFile = path.join(RUN, `${name}.token`)
    fs.writeFileSync(a.tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  // Scratch app settings under /tmp, never the user's ~/.config/<app>.
  const xdg = process.env.SPIKE_XDG || '/tmp/lm-xdg'
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: `${xdg}/config`,
    XDG_DATA_HOME: `${xdg}/data`,
    XDG_CACHE_HOME: `${xdg}/cache`,
    XDG_STATE_HOME: `${xdg}/state`,
  }
  delete env.ELECTRON_RUN_AS_NODE
  a.unit = `nd-${name}-${process.pid}`
  const t0 = Date.now()
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', `--unit=${a.unit}`, '--', spec.bin, ...spec.args(a)], {
    env,
    stdio: ['ignore', fs.openSync(path.join(RUN, `${name}.log`), 'a'), fs.openSync(path.join(RUN, `${name}.log`), 'a')],
  })
  a.pid = child.pid
  a.child = child
  a.early = early
  // Before the app can create its window (it takes hundreds of ms to get there).
  await x('expect', { pid: a.pid, mode: early })
  child.on('exit', (code, sig) => {
    log(`${name} exited`, code, sig)
    delete running[name]
    if (shown === name) shown = null
  })
  running[name] = a
  const t = { spawnMs: Date.now() - t0 }
  const f = await x('find', { pid: a.pid, timeout: 30 })
  if (!f.found) throw new Error(`no window for ${name} pid ${a.pid}: ${JSON.stringify(f.all)}`)
  a.wid = f.found.wid
  t.windowMappedMs = Date.now() - t0
  t.findCalls = f.calls
  if (MODE === 'overlay') {
    t.overlay = await x('overlay', { wid: a.wid, transient_for: electronXid() })
  } else {
    t.dock = await x('dock', { wid: a.wid, parent: electronXid(), x: stage.x, y: stage.y, w: stage.w, h: stage.h })
    if (process.env.SPIKE_GUARD !== '0') {
      t.guard = await x('guard', { top: electronXid(), apps: Object.values(running).filter((r) => r.wid).map((r) => r.wid) })
    }
  }
  t.dockedMs = Date.now() - t0
  a.t0 = t0
  return t
}

async function fitShown() {
  if (!shown || !running[shown]) return
  const a = running[shown]
  if (MODE === 'overlay') {
    const s = await stageOnRoot()
    await x('overlay_fit', { wid: a.wid, rx: s.rx, ry: s.ry, w: s.w, h: s.h })
  } else {
    await x('fit', { wid: a.wid, x: stage.x, y: stage.y, w: stage.w, h: stage.h, redirect_mode: REDIRECT })
    if (process.env.SPIKE_GUARD !== '0') await x('shown', { wid: a.wid, x: stage.x, y: stage.y, w: stage.w, h: stage.h })
  }
}

async function park(name) {
  const a = running[name]
  if (!a) return
  if (MODE === 'overlay') {
    await x('overlay_fit', { wid: a.wid, rx: -5000, ry: 0, w: stage.w, h: stage.h })
  } else {
    await x('park', { wid: a.wid, w: stage.w, redirect_mode: REDIRECT })
  }
}

async function open(name, early) {
  const t0 = Date.now()
  const out = { app: name, cold: !running[name], t0 }
  for (const other of Object.keys(running)) if (other !== name) await park(other)
  if (!running[name]) Object.assign(out, await launch(name, early))
  shown = name
  await fitShown()
  out.fittedMs = Date.now() - t0
  win.webContents.send('shown', name)
  return out
}

// MCP bridges, started on first use: `<app>-cli mcp <bridge flags>` over stdio.
const bridges = {}
function bridge(name) {
  if (bridges[name]) return bridges[name]
  const spec = APPS[name]
  const a = running[name] || { port: spec.port, tokenFile: path.join(RUN, `${name}.token`) }
  const p = spawn(spec.cli, spec.bridge(a), { stdio: ['pipe', 'pipe', 'pipe'] })
  const b = { p, seq: 0, waiters: new Map(), buf: '', ready: null, stderr: '' }
  p.stderr.on('data', (d) => (b.stderr += d))
  p.stdout.on('data', (d) => {
    b.buf += d
    let i
    while ((i = b.buf.indexOf('\n')) >= 0) {
      const line = b.buf.slice(0, i)
      b.buf = b.buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const w = b.waiters.get(msg.id)
      if (w) { b.waiters.delete(msg.id); w(msg) }
    }
  })
  b.call = (method, params) =>
    new Promise((resolve) => {
      const id = ++b.seq
      b.waiters.set(id, resolve)
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  b.ready = b
    .call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-dock-spike', version: '0' } })
    .then((r) => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      return r
    })
  bridges[name] = b
  return b
}

async function mcp(name, tool, args = {}, timeoutMs = 70000) {
  const b = bridge(name)
  const tInit = Date.now()
  await b.ready
  const initMs = Date.now() - tInit
  const t0 = Date.now()
  const r = await Promise.race([
    b.call('tools/call', { name: tool, arguments: args }),
    new Promise((res) => setTimeout(() => res({ timeout: true }), timeoutMs)),
  ])
  const ms = Date.now() - t0
  const content = r.result?.content || []
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const images = content.filter((c) => c.type === 'image')
  // Full replies go to run/ so long ones can be read after the call.
  fs.writeFileSync(path.join(RUN, `last-mcp-${name}.txt`), text)
  images.forEach((im, i) => fs.writeFileSync(path.join(RUN, `last-mcp-${name}-${i}.png`), Buffer.from(im.data, 'base64')))
  return { ms, initMs, isError: r.result?.isError || !!r.error, error: r.error, timeout: !!r.timeout, textBytes: text.length, text: text.slice(0, 600), images: images.map((i) => ({ mime: i.mimeType, bytes: i.data.length, data: i.data })) }
}


// ---- measurement helpers -------------------------------------------------

function closeApp(name) {
  const a = running[name]
  if (!a) return { wasRunning: false }
  if (bridges[name]) { bridges[name].p.kill(); delete bridges[name] }
  return new Promise((resolve) => {
    const t0 = Date.now()
    a.child.once('exit', () => resolve({ exitMs: Date.now() - t0 }))
    process.kill(a.pid, 'SIGTERM')
    setTimeout(() => { try { process.kill(a.pid, 'SIGKILL') } catch {} }, 5000)
  })
}

// Raw control channel, no bridge: connect, (auth), ui.inspect, first reply.
function ctlOnce(name) {
  const spec = APPS[name]
  return new Promise((resolve) => {
    const c = net.connect(spec.port, '127.0.0.1')
    let buf = ''
    const done = (ok) => { c.destroy(); resolve(ok) }
    c.on('error', () => done(false))
    c.setTimeout(3000, () => done(false))
    c.on('connect', () => {
      if (spec.token) c.write(JSON.stringify({ id: 'auth', method: 'auth', params: { token: fs.readFileSync(path.join(RUN, `${name}.token`), 'utf8').trim() } }) + '\n')
      c.write(JSON.stringify({ id: 1, method: 'ui.inspect', params: {} }) + '\n')
    })
    c.on('data', (d) => {
      buf += d
      for (const line of buf.split('\n').slice(0, -1)) {
        try { if (JSON.parse(line).id === 1) return done(true) } catch {}
      }
    })
  })
}

async function ctlPing(name, t0 = Date.now(), limit = 30000) {
  while (Date.now() - t0 < limit) {
    if (await ctlOnce(name)) return { ms: Date.now() - t0 }
    await new Promise((r) => setTimeout(r, 20))
  }
  return { ms: null }
}

async function coldOpen(name) {
  if (running[name]) await closeApp(name)
  // The shown app (if any) is what the region shows before; base snapshot of it.
  const s = await stageOnRoot()
  await xf('snap', { name: 'base', ...s })
  const t0 = Date.now()
  const frame = xf('wait_frame', { rx: s.rx, ry: s.ry, w: s.w, h: s.h, mode: 'drawn2', ref: 'base', timeout: 30, interval: 0.01 }).then((r) => ({ ...r, atMs: Date.now() - t0 }))
  const openP = open(name)
  const ctlP = (async () => { while (!running[name]) await new Promise((r) => setTimeout(r, 5)); return ctlPing(name, t0) })()
  const [o, f, c] = await Promise.all([openP, frame, ctlP])
  return { app: name, windowMappedMs: o.windowMappedMs, dockedMs: o.dockedMs, firstFrameMs: f.atMs, frame: f, controlAnswersMs: c.ms }
}

// Show a parked app and time its first correct frame against a snapshot ('ref')
// taken while it was last shown. liftFirst removes MemoryHigh before the move.
async function showTimed({ app: name, ref, liftFirst = true, tol = 0.02 }) {
  const s = await stageOnRoot()
  const t0 = Date.now()
  let liftMs = null
  if (liftFirst) {
    await sh('systemctl', ['--user', 'set-property', '--runtime', `${running[name].unit}.scope`, 'MemoryHigh=infinity', 'CPUWeight=100'])
    liftMs = Date.now() - t0
  }
  const frame = xf('wait_frame', { rx: s.rx, ry: s.ry, w: s.w, h: s.h, mode: 'match', ref, timeout: 30, interval: 0.005, tol }).then((r) => ({ ...r, atMs: Date.now() - t0 }))
  await open(name)
  const movedMs = Date.now() - t0
  const f = await frame
  return { liftMs, movedMs, frameMs: f.ms === null ? null : f.atMs, raw: f }
}

function cgroup(name) {
  const a = running[name]
  const base = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${a.unit}.scope`
  const rd = (f) => { try { return fs.readFileSync(`${base}/${f}`, 'utf8').trim() } catch (e) { return null } }
  return { unit: a.unit, current: Number(rd('memory.current')), swap: Number(rd('memory.swap.current')), high: rd('memory.high'), weight: rd('cpu.weight'), cpuStat: rd('cpu.stat')?.split('\n')[0] }
}

// The spike's own control socket, for drive.mjs.
const OPS = {
  open: ({ app: n, early }) => open(n, early),
  park: ({ app: n }) => park(n),
  state: async () => ({
    mode: MODE,
    stage,
    shown,
    electronXid: electronXid(),
    bounds: win.getBounds(),
    content: win.getContentBounds(),
    stageOnRoot: await stageOnRoot(),
    apps: Object.fromEntries(Object.entries(running).map(([k, v]) => [k, { pid: v.pid, wid: v.wid, unit: v.unit, port: v.port }])),
  }),
  eval: ({ js }) => win.webContents.executeJavaScript(js),
  x: ({ req }) => x(req.op, req.args || {}),
  resize: ({ w, h }) => new Promise((res) => { win.setSize(w, h); setTimeout(() => res(win.getContentBounds()), 400) }),
  move: ({ x: px, y: py }) => new Promise((res) => { win.setPosition(px, py); setTimeout(() => res(win.getBounds()), 400) }),
  mcp: ({ app: n, tool, args, timeoutMs }) => mcp(n, tool, args, timeoutMs),
  focusWindow: () => { win.focus(); return true },
  quit: () => { setTimeout(() => app.quit(), 50); return true },
  xf: ({ req }) => xf(req.op, req.args || {}),
  close: ({ app: n }) => closeApp(n),
  coldOpen: ({ app: n }) => coldOpen(n),
  showTimed: (r) => showTimed(r),
  ctlPing: ({ app: n }) => ctlPing(n),
  cgroup: ({ app: n }) => cgroup(n),
  setProp: ({ app: n, props }) => sh('systemctl', ['--user', 'set-property', '--runtime', `${running[n].unit}.scope`, ...props]),
}

function serve() {
  const sock = path.join(RUN, 'ctl.sock')
  try { fs.unlinkSync(sock) } catch {}
  net.createServer((c) => {
    let buf = ''
    c.on('data', async (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const req = JSON.parse(line)
        try {
          const result = await OPS[req.op](req)
          c.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n')
        } catch (e) {
          c.write(JSON.stringify({ id: req.id, ok: false, error: String(e.stack || e) }) + '\n')
        }
      }
    })
  }).listen(sock)
}

ipcMain.on('stage', (_e, r) => {
  stage = r
  fitShown().catch((e) => log('fit failed', e))
})
ipcMain.handle('open', (_e, n) => open(n))
// A press on Electron's own DOM takes keyboard focus back from a docked app.
ipcMain.on('dom-pointerdown', () => {
  if (MODE === 'reparent' && process.env.SPIKE_GUARD !== '0') x('want_electron').catch(() => {})
})

if (process.env.SPIKE_USERDATA) app.setPath('userData', process.env.SPIKE_USERDATA)

app.whenReady().then(() => {
  // No menu bar: it is drawn inside the X window and would offset the region.
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    x: Number(process.env.SPIKE_X || 0),
    y: Number(process.env.SPIKE_Y || 0),
    title: 'native-dock spike',
    backgroundColor: '#1d1f24',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  win.loadFile(path.join(HERE, 'index.html'))
  win.webContents.once('did-finish-load', () => x('watch', { electron: electronXid() }).catch((e) => log('watch failed', e)))
  win.on('move', () => { if (MODE === 'overlay') fitShown().catch(() => {}) })
  serve()
})

function cleanup() {
  for (const b of Object.values(bridges)) b.p.kill()
  for (const a of Object.values(running)) { try { process.kill(a.pid, 'SIGTERM') } catch {} }
  x.proc.kill()
  xf.proc.kill()
}
app.on('before-quit', cleanup)
app.on('window-all-closed', () => app.quit())
