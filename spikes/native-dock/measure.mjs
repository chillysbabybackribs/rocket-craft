// Measurement run for the native-dock spike. Needs the spike running (main.js) on a
// display; talks to it over run/ctl.sock and writes run/measure-<label>.json.
//
//   node measure.mjs <label> [cold|parked|squeeze|all] [doc]
//
// `doc` loads a heavier document first (PhotoCraft 4000x3000 with noise, GridCraft
// 20,000 cells) so memory and show-after-rest are not only empty-app numbers.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = import.meta.dirname
const [label = 'run', what = 'all', doc] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sock = net.connect(path.join(HERE, 'run', 'ctl.sock'))
await new Promise((r) => sock.once('connect', r))
const waiters = new Map()
let seq = 0
let buf = ''
sock.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    const w = waiters.get(m.id)
    waiters.delete(m.id)
    if (w) m.ok ? w.resolve(m.result) : w.reject(new Error(m.error))
  }
})
function ctl(op, args = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject })
    sock.write(JSON.stringify({ id, op, ...args }) + '\n')
  })
}
const mcp = async (app, tool, args = {}, timeoutMs = 65000) => {
  const r = await ctl('mcp', { app, tool, args, timeoutMs })
  delete r.images
  return r
}
const INSPECT = { photo: 'ui_inspect', grid: 'inspect_workbook' }
const out = { label, at: new Date().toISOString(), display: process.env.DISPLAY, doc: !!doc }
const save = () => fs.writeFileSync(path.join(HERE, 'run', `measure-${label}.json`), JSON.stringify(out, null, 1))
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
function pointerAway() {
  try { execFileSync('xdotool', ['mousemove', '100', '600']) } catch {}
}

async function closeAll() {
  await ctl('close', { app: 'photo' })
  await ctl('close', { app: 'grid' })
  await sleep(500)
}

async function loadDoc(app) {
  if (app === 'photo') {
    await mcp('photo', 'command_run', { id: 'file.new', params: { width: 4000, height: 3000, name: 'big' } })
    const r = await mcp('photo', 'command_run', { id: 'filter.noise.addNoise', params: { amount: 40 } })
    await mcp('photo', 'command_run', { id: 'layer.duplicate', params: {} })
    await mcp('photo', 'command_run', { id: 'filter.blur.gaussianBlur', params: { radius: 6 } })
    return r
  }
  const values = Array.from({ length: 1000 }, (_, r) => Array.from({ length: 20 }, (_, c) => (c === 19 ? `=SUM(A${r + 1}:S${r + 1})` : r * 20 + c)))
  return mcp('grid', 'write_range', { range: 'A1', values })
}

async function timeCalls(app, n = 5) {
  await mcp(app, INSPECT[app]) // reconnect if the app dropped an idle bridge connection
  const ms = []
  for (let i = 0; i < n; i++) ms.push((await mcp(app, INSPECT[app])).ms)
  return ms
}

async function screenshot(app) {
  const t0 = Date.now()
  const r = app === 'photo'
    ? await mcp('photo', 'ui_screenshot', { max_side: 800 }, 30000)
    : await mcp('grid', 'screenshot', { path: path.join(HERE, 'run', `grid-shot-${label}.png`) }, 30000)
  return { ms: Date.now() - t0, ok: !r.isError && !r.timeout, timeout: r.timeout, text: r.text?.slice(0, 160) }
}

async function cold() {
  out.cold = []
  for (let round = 0; round < 3; round++) {
    for (const app of ['grid', 'photo']) {
      await closeAll()
      pointerAway()
      const r = await ctl('coldOpen', { app })
      log('cold', app, JSON.stringify(r))
      out.cold.push(r)
      save()
      await sleep(1500)
    }
  }
}

async function bothRunning() {
  const st = await ctl('state')
  for (const app of ['grid', 'photo']) if (!st.apps[app]) await ctl('open', { app })
  await sleep(2500)
  if (doc && !out.docLoaded) {
    out.docLoaded = { photo: await loadDoc('photo'), grid: await loadDoc('grid') }
    await sleep(2000)
  }
}

async function refOf(app) {
  await ctl('open', { app })
  pointerAway()
  await ctl('setProp', { app, props: ['MemoryHigh=infinity', 'CPUWeight=100'] })
  await sleep(2500)
  const s = (await ctl('state')).stageOnRoot
  await ctl('xf', { req: { op: 'snap', args: { name: `ref-${app}`, ...s } } })
  return s
}

async function parked() {
  await bothRunning()
  out.parked = {}
  for (const app of ['photo', 'grid']) {
    const other = app === 'photo' ? 'grid' : 'photo'
    await refOf(app)
    const shownCalls = await timeCalls(app)
    const shownShot = await screenshot(app)
    await ctl('open', { app: other })
    await sleep(3000)
    const r = {
      shownInspectMs: shownCalls,
      shownScreenshot: shownShot,
      parkedInspectMs: await timeCalls(app),
      parkedScreenshot: await screenshot(app),
      cgroup: await ctl('cgroup', { app }),
    }
    // Un-park with no squeeze: the baseline for show-after-rest.
    await sleep(3000)
    r.unpark = await ctl('showTimed', { app, ref: `ref-${app}`, liftFirst: false })
    log('parked', app, JSON.stringify(r))
    out.parked[app] = r
    save()
  }
}

async function squeeze() {
  await bothRunning()
  out.squeeze = {}
  for (const app of ['photo', 'grid']) {
    const other = app === 'photo' ? 'grid' : 'photo'
    await refOf(app)
    await ctl('open', { app: other })
    await sleep(2000)
    const r = { before: await ctl('cgroup', { app }), samples: [] }
    const t0 = Date.now()
    r.setProp = await ctl('setProp', { app, props: ['MemoryHigh=48M', 'CPUWeight=1'] })
    for (const at of [1000, 2000, 4000, 8000, 15000]) {
      await sleep(at - (Date.now() - t0))
      const c = await ctl('cgroup', { app })
      r.samples.push({ atMs: Date.now() - t0, current: c.current, swap: c.swap, high: c.high, weight: c.weight })
    }
    r.squeezedInspectMs = await timeCalls(app)
    r.squeezedScreenshot = await screenshot(app)
    r.afterCalls = await ctl('cgroup', { app })
    // Let it settle back under the limit, then show it: lift first, as the plan says.
    await sleep(8000)
    r.beforeShow = await ctl('cgroup', { app })
    r.showLifted = await ctl('showTimed', { app, ref: `ref-${app}`, liftFirst: true })
    r.afterShow = await ctl('cgroup', { app })
    // Same again but forgetting to lift: shows the cost of drawing while squeezed.
    await ctl('open', { app: other })
    await ctl('setProp', { app, props: ['MemoryHigh=48M', 'CPUWeight=1'] })
    await sleep(12000)
    r.beforeShowNoLift = await ctl('cgroup', { app })
    r.showNotLifted = await ctl('showTimed', { app, ref: `ref-${app}`, liftFirst: false })
    await ctl('setProp', { app, props: ['MemoryHigh=infinity', 'CPUWeight=100'] })
    log('squeeze', app, JSON.stringify(r))
    out.squeeze[app] = r
    save()
  }
}

if (what === 'cold' || what === 'all') await cold()
if (what === 'parked' || what === 'all') await parked()
if (what === 'squeeze' || what === 'all') await squeeze()
save()
log('saved', path.join(HERE, 'run', `measure-${label}.json`))
sock.end()
process.exit(0)
