import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { craftApp } from '../shared/craft-apps.ts'
import type { CraftRunState } from '../shared/types.ts'
import {
  CAPTURE_TIMEOUT_MS, CraftDock, PRESSURE_POLL_MS, REST_AFTER_MS, checkBounds, limitsFor, memoryPressure, toDeviceRect, xidOf,
  type Limits, type Started, type XRequest
} from './craft-dock.ts'
import { isOrDescends } from './craft-dock/x11-helper.ts'

// The dock with a fake X11 helper and fake processes: every call is recorded in one log, so the
// tests can check what happened and in which order (limits lifted before a show, parked before
// another app is shown).

type Harness = {
  dock: CraftDock
  log: string[]
  runs: Array<{ id: string; run: CraftRunState; error?: string }>
  exit: (id: string, code?: number | null, signal?: string | null) => void
  capture: (id: string) => void
  launches: Map<string, number>
  pressure: { text: string }
}

function harness(options: { autoCapture?: boolean } = {}): Harness {
  const log: string[] = []
  const runs: Harness['runs'] = []
  const launches = new Map<string, number>()
  const exits = new Map<string, (value: { code: number | null; signal: string | null }) => void>()
  const pressure = { text: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' }
  let dock!: CraftDock
  const capture = (id: string): void => dock.onHelperEvent({ event: 'captured', launch: launches.get(id)!, wid: 100 + launches.get(id)!, how: 'early', ms: 5, fresh: true })
  dock = new CraftDock({
    x: async (request: XRequest) => {
      const id = 'launch' in request ? [...launches].find(([, launch]) => launch === request.launch)?.[0] : ''
      log.push(`x:${request.op}${id ? `:${id}` : ''}${request.op === 'park' || request.op === 'redirect' ? `:${'redirect' in request ? request.redirect : request.on}` : ''}${request.op === 'show' ? `:${request.rect.x},${request.rect.y},${request.rect.width}x${request.rect.height}` : ''}`)
      if (request.op === 'expect' && options.autoCapture !== false) queueMicrotask(() => capture(id!))
      return {}
    },
    start: async (app, launch, folder) => {
      launches.set(app.id, launch)
      log.push(`start:${app.id}${folder ? `:${folder}` : ''}`)
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => exits.set(app.id, done))
      return { pid: 1000 + launch, unit: `craft-studio-${app.id}-${launch}`, exited, control: { port: 4000 + launch, tokenFile: null, controlFile: null, configHome: '/c', cli: '/cli', folder: null } } satisfies Started
    },
    setLimits: async (unit: string, limits: Limits) => { log.push(`limits:${unit.split('-')[2]}:${limits.memoryHigh}/${limits.cpuWeight}`) },
    stop: async (started) => {
      const id = started.unit!.split('-')[2]!
      log.push(`stop:${id}`)
      exits.get(id)?.({ code: null, signal: 'SIGTERM' })
    },
    scale: () => 1,
    content: () => ({ width: 1600, height: 1000 }),
    app: craftApp,
    onRun: (id, run, error) => runs.push(error ? { id, run, error } : { id, run }),
    readPressure: async () => pressure.text
  })
  return { dock, log, runs, exit: (id, code = 0, signal = null) => exits.get(id)?.({ code, signal }), capture, launches, pressure }
}

const B = { x: 400, y: 40, width: 800, height: 600 }
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)) }

test('first show starts the app, catches its window, lifts its limits and then shows it', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B, '/work')
  assert.deepEqual(h.log, ['start:gridcraft:/work', 'x:expect:gridcraft', 'limits:gridcraft:infinity/100', 'x:show:gridcraft:400,40,800x600'])
  assert.deepEqual(h.runs.map((r) => r.run), ['starting', 'shown'])
  assert.equal(h.dock.runOf('gridcraft'), 'shown')
  assert.equal(h.dock.controlOf('gridcraft')?.port, 4001)
})

test('switching parks the shown app (redirected) before showing the next; switching back starts nothing', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B)
  await h.dock.show('photocraft', B)
  const afterSwitch = h.log.slice(h.log.indexOf('start:photocraft'))
  assert.deepEqual(afterSwitch, [
    'start:photocraft', 'x:expect:photocraft',
    'x:park:gridcraft:true', 'limits:gridcraft:infinity/50',
    'limits:photocraft:infinity/100', 'x:show:photocraft:400,40,800x600'
  ])
  assert.equal(h.dock.runOf('gridcraft'), 'working')
  h.log.length = 0
  await h.dock.show('gridcraft', B)
  assert.deepEqual(h.log, ['x:park:photocraft:true', 'limits:photocraft:infinity/50', 'limits:gridcraft:infinity/100', 'x:show:gridcraft:400,40,800x600'])
  assert.equal(h.dock.shown(), 'gridcraft')
})

test('a hidden app rests after two idle minutes: squeezed and no longer redirected; a model call lifts it first', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  try {
    const h = harness()
    await h.dock.show('gridcraft', B)
    await h.dock.hide()
    assert.equal(h.dock.runOf('gridcraft'), 'working')
    h.log.length = 0
    mock.timers.tick(REST_AFTER_MS - 1)
    await flush()
    assert.equal(h.dock.runOf('gridcraft'), 'working')
    mock.timers.tick(1)
    await flush()
    assert.equal(h.dock.runOf('gridcraft'), 'resting')
    assert.deepEqual(h.log, ['limits:gridcraft:64M/5', 'x:redirect:gridcraft:false'])
    h.log.length = 0
    const control = await h.dock.touch('gridcraft')
    assert.equal(control.port, 4001)
    assert.deepEqual(h.log, ['limits:gridcraft:infinity/50', 'x:redirect:gridcraft:true'])
    assert.equal(h.dock.runOf('gridcraft'), 'working')
    // A call pushes the rest back by two minutes from the call.
    mock.timers.tick(REST_AFTER_MS - 10)
    await flush()
    assert.equal(h.dock.runOf('gridcraft'), 'working')
    mock.timers.tick(10)
    await flush()
    assert.equal(h.dock.runOf('gridcraft'), 'resting')
    await h.dock.stopAll()
  } finally {
    mock.timers.reset()
  }
})

test('showing a resting app lifts its limits before it is moved into view', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  try {
    const h = harness()
    await h.dock.show('gridcraft', B)
    await h.dock.hide()
    mock.timers.tick(REST_AFTER_MS)
    await flush()
    h.log.length = 0
    await h.dock.show('gridcraft', B)
    assert.deepEqual(h.log, ['limits:gridcraft:infinity/100', 'x:show:gridcraft:400,40,800x600'])
    await h.dock.stopAll()
  } finally {
    mock.timers.reset()
  }
})

test('a model call to an app that is not running starts it parked and never shows it', async () => {
  const h = harness()
  await h.dock.show('photocraft', B)
  const control = await h.dock.touch('gridcraft')
  await flush()
  assert.equal(control.port, 4002)
  assert.equal(h.dock.runOf('gridcraft'), 'working')
  assert.equal(h.dock.shown(), 'photocraft')
  assert.ok(!h.log.some((line) => line.startsWith('x:show:gridcraft')))
})

test('a model call that starts an app confines it to the calling chat\'s folder; a running app keeps its own', async () => {
  const h = harness()
  await h.dock.show('photocraft', B, '/shown')
  await h.dock.touch('gridcraft', '/chat')
  await h.dock.touch('photocraft', '/chat')
  assert.deepEqual(h.log.filter((line) => line.startsWith('start:')), ['start:photocraft:/shown', 'start:gridcraft:/chat'])
  assert.equal(h.dock.launchOf('gridcraft'), 2)
  assert.equal(h.dock.launchOf('vectorcraft'), null)
})

test('bounds changes refit the shown app only when they change', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B)
  h.log.length = 0
  await h.dock.setBounds(B)
  assert.deepEqual(h.log, [])
  await h.dock.setBounds({ ...B, width: 900.4 })
  assert.deepEqual(h.log, ['x:show:gridcraft:400,40,900x600'])
})

test('hide before a cold start finishes leaves the app parked, not shown', async () => {
  const h = harness({ autoCapture: false })
  const showing = h.dock.show('gridcraft', B)
  await flush()
  await h.dock.hide()
  h.capture('gridcraft')
  await showing
  await flush()
  assert.ok(!h.log.some((line) => line.startsWith('x:show')))
  assert.equal(h.dock.runOf('gridcraft'), 'working')
})

test('an app that quits by itself is reported stopped, with a sentence when it crashed', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B)
  h.exit('gridcraft', 0)
  await flush()
  assert.deepEqual(h.runs.at(-1), { id: 'gridcraft', run: 'stopped' })
  await h.dock.show('photocraft', B)
  h.exit('photocraft', null, 'SIGSEGV')
  await flush()
  assert.match(h.runs.at(-1)!.error!, /PhotoCraft quit unexpectedly \(SIGSEGV\)\. Open it again/)
  assert.equal(h.dock.shown(), null)
  assert.ok(h.log.includes('x:forget:photocraft'))
})

test('an app that dies while starting fails its show with a sentence', async () => {
  const h = harness({ autoCapture: false })
  const showing = h.dock.show('gridcraft', B)
  await flush()
  h.exit('gridcraft', 3)
  await assert.rejects(showing, /GridCraft quit while starting \(exit code 3\)/)
})

test('a window that never appears is given up after the timeout, and the app is stopped', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const h = harness({ autoCapture: false })
    const showing = h.dock.show('gridcraft', B)
    await flush()
    mock.timers.tick(CAPTURE_TIMEOUT_MS)
    await assert.rejects(showing, /did not appear within 30 seconds/)
    await flush()
    assert.ok(h.log.includes('stop:gridcraft'))
  } finally {
    mock.timers.reset()
  }
})

test('a lost window (the app relaunching itself) is waited for again and then shown', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B)
  h.dock.onHelperEvent({ event: 'lost', launch: h.launches.get('gridcraft')! })
  assert.equal(h.dock.runOf('gridcraft'), 'starting')
  h.log.length = 0
  h.capture('gridcraft')
  await flush()
  assert.equal(h.dock.runOf('gridcraft'), 'shown')
  // Its limits were never lowered, so only the window moves.
  assert.deepEqual(h.log, ['x:show:gridcraft:400,40,800x600'])
})

test('stopAll stops every app it started', async () => {
  const h = harness()
  await h.dock.show('gridcraft', B)
  await h.dock.show('photocraft', B)
  await h.dock.stopAll()
  assert.deepEqual(h.log.filter((line) => line.startsWith('stop:')).sort(), ['stop:gridcraft', 'stop:photocraft'])
  assert.equal(h.dock.runOf('gridcraft'), 'stopped')
  await assert.rejects(h.dock.show('gridcraft', B), /quitting/)
})

test('memory pressure tightens resting apps and lets go when it passes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 5_000_000 })
  try {
    const h = harness()
    await h.dock.show('gridcraft', B)
    await h.dock.hide()
    mock.timers.tick(REST_AFTER_MS)
    await flush()
    h.log.length = 0
    h.pressure.text = 'some avg10=35.10 avg60=20.00 avg300=5.00 total=1\nfull avg10=4.00 avg60=1 avg300=0 total=1\n'
    mock.timers.tick(PRESSURE_POLL_MS)
    await flush()
    assert.deepEqual(h.log, ['limits:gridcraft:32M/1'])
    h.pressure.text = 'some avg10=0.50 avg60=1.00 avg300=1.00 total=2\n'
    mock.timers.tick(PRESSURE_POLL_MS)
    await flush()
    assert.deepEqual(h.log, ['limits:gridcraft:32M/1', 'limits:gridcraft:64M/5'])
    await h.dock.stopAll()
  } finally {
    mock.timers.reset()
  }
})

test('limits per state', () => {
  assert.deepEqual(limitsFor('shown'), { memoryHigh: 'infinity', cpuWeight: 100 })
  assert.deepEqual(limitsFor('working'), { memoryHigh: 'infinity', cpuWeight: 50 })
  assert.deepEqual(limitsFor('resting'), { memoryHigh: '64M', cpuWeight: 5 })
  assert.deepEqual(limitsFor('resting', true), { memoryHigh: '32M', cpuWeight: 1 })
})

test('bounds become X pixels with rounded edges, kept inside the window', () => {
  assert.deepEqual(toDeviceRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, 1), { x: 10, y: 21, width: 101, height: 50 })
  assert.deepEqual(toDeviceRect({ x: 10, y: 20, width: 100, height: 50 }, 1.5), { x: 15, y: 30, width: 150, height: 75 })
  assert.deepEqual(toDeviceRect({ x: 1500, y: -10, width: 300, height: 200 }, 1, { width: 1600, height: 1000 }), { x: 1500, y: 0, width: 100, height: 190 })
  assert.deepEqual(toDeviceRect({ x: 0, y: 0, width: 0, height: 0 }, 1), { x: 0, y: 0, width: 1, height: 1 })
  assert.deepEqual(toDeviceRect({ x: 2, y: 2, width: 4, height: 4 }, Number.NaN), { x: 2, y: 2, width: 4, height: 4 })
})

test('renderer bounds are checked, and the native handle reads as an XID', () => {
  assert.deepEqual(checkBounds({ x: 1, y: 2, width: 3, height: 4, extra: 5 }), { x: 1, y: 2, width: 3, height: 4 })
  for (const bad of [null, { x: 1 }, { x: 0, y: 0, width: -1, height: 2 }, { x: 0, y: 0, width: Infinity, height: 2 }, { x: '1', y: 0, width: 1, height: 1 }]) {
    assert.throws(() => checkBounds(bad), /region’s size/)
  }
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(0x2a00004n)
  assert.equal(xidOf(handle), 0x2a00004)
})

test('memory pressure is read from the some avg10 field', () => {
  assert.equal(memoryPressure('some avg10=12.34 avg60=1 avg300=0 total=9\nfull avg10=50.00 avg60=0 avg300=0 total=1\n'), 12.34)
  assert.equal(memoryPressure(''), 0)
})

test('a window belongs to a launch through its process tree', () => {
  const parents: Record<number, number> = { 30: 20, 20: 10, 10: 1 }
  assert.equal(isOrDescends(10, 10, (pid) => parents[pid] ?? null), true)
  assert.equal(isOrDescends(30, 10, (pid) => parents[pid] ?? null), true)
  assert.equal(isOrDescends(30, 99, (pid) => parents[pid] ?? null), false)
})
