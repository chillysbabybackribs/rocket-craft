// One app through its life: idle, with a document, hidden (throttling off, then on), after a
// simulated memory-pressure signal, squeezed by a cgroup limit, shown again, then discarded and
// reopened. At each stage: the app renderer's RSS and swap, every Electron process, CPU use, and
// how fast the page (and FilmCraft's control API) answers.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MEDIA = join(process.cwd(), 'media')
const DOCS = {
  photocraft: { file: 'photo-4000x3000.jpg', title: 'photo-4000x3000.jpg' },
  gridcraft: { file: 'table-20000x10.csv', title: 'table-20000x10.csv' }
}

function cpuTicks(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch { return null }
}

/** CPU use of the app renderer and the GPU process over `ms`, as % of one core. */
async function cpu(host, name, ms, sleep) {
  const pids = { renderer: host.contents(name).getOSProcessId(), gpu: host.allMem().find((m) => m.type === 'GPU')?.pid }
  const before = Object.fromEntries(Object.entries(pids).map(([k, pid]) => [k, cpuTicks(pid)]))
  await sleep(ms)
  return Object.fromEntries(Object.entries(pids).map(([k, pid]) => [k, Math.round((cpuTicks(pid) - before[k]) / (ms / 1000) * 10) / 10]))
}

const CG = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice'
function cgMem(unit) {
  const read = (f) => { try { return Math.round(Number(readFileSync(`${CG}/${unit}/${f}`, 'utf8')) / 1048576 * 10) / 10 } catch { return null } }
  return { currentMB: read('memory.current'), swapMB: read('memory.swap.current') }
}

function sum(all) {
  return Math.round(all.reduce((a, m) => a + (m.rssMB || 0), 0))
}

async function waitConsole(host, name, text, ms, sleep) {
  const t0 = Date.now()
  const consoles = host.views.get(name).consoles
  while (Date.now() - t0 < ms) {
    if (consoles.some((c) => c.includes(text))) return Date.now() - t0
    await sleep(50)
  }
  return null
}

async function openDoc(host, name, sleep) {
  const t0 = Date.now()
  if (name === 'filmcraft') {
    const r = await host.js(name, `(async () => {
      const imp = await filmcraft.importUrl('/__media/clip-720p-10s.mp4', 'clip.mp4')
      const seq = await filmcraft.execute('file.newSequence', { fromItem: imp.items[0] })
      return JSON.parse(JSON.stringify({ imp, seq }))
    })()`)
    return { ms: Date.now() - t0, result: r }
  }
  const doc = DOCS[name]
  const dbg = await host.cdp(name)
  await dbg.sendCommand('Page.enable')
  await dbg.sendCommand('DOM.enable')
  await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  if (name === 'photocraft') {
    const opened = new Promise((done) => {
      const on = async (_e, method, params) => {
        if (method !== 'Page.fileChooserOpened') return
        dbg.removeListener('message', on)
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [join(MEDIA, doc.file)], backendNodeId: params.backendNodeId })
        done()
      }
      dbg.on('message', on)
    })
    host.click(name, 560, 500)
    await sleep(200)
    host.key(name, 'O', ['control'])
    await opened
  } else {
    const data = { items: [], files: [join(MEDIA, doc.file)], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, x: 560, y: 430, data })
  }
  const shownMs = await waitConsole(host, name, `Title("${doc.title}`, 60_000, sleep)
  return { ms: shownMs == null ? null : Date.now() - t0 }
}

/** A control call through the app's own API where it has one, else a bare script round trip. */
function controlProbe(name) {
  return name === 'filmcraft' ? `filmcraft.request('ui.inspect', {}).then((r) => document.visibilityState + ' ' + typeof r)` : 'document.visibilityState'
}

function scope(unit, pid, memoryHigh) {
  execFileSync('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
    'StartTransientUnit', 'ssa(sv)a(sa(sv))', unit, 'fail', '2', 'PIDs', 'au', '1', String(pid), 'MemoryHigh', 't', memoryHigh === 'infinity' ? '18446744073709551615' : String(memoryHigh), '0'])
}

function setProp(unit, prop) {
  execFileSync('systemctl', ['--user', 'set-property', '--runtime', unit, prop])
}

export async function run(host, { sleep }) {
  const name = process.env.SPIKE_APP
  const stages = host.results.stages = []
  const unit = `craft-webview-${name}-${process.pid}.scope`
  const rec = async (stage, extra = {}) => {
    const all = host.allMem()
    const row = { stage, t: Date.now(), renderer: host.mem(name), scope: cgMem(unit), gpu: all.find((m) => m.type === 'GPU'), browser: all.find((m) => m.type === 'Browser'), totalRssMB: sum(all), ...extra }
    stages.push(row)
    host.log(stage, row.renderer, row.scope, `gpu ${row.gpu?.rssMB}`, `total ${row.totalRssMB}`, extra)
    return row
  }

  // Each renderer gets its own scope as soon as its process is known, so the memory it allocates
  // afterwards is charged there (cgroup v2 never moves pages already charged elsewhere).
  let scoped = false
  host.results.timing = await host.open(name, { onCommit: (pid) => {
    try { scope(unit, pid, 'infinity'); scoped = true; host.log(`renderer ${pid} in ${unit}`) } catch (error) { host.log(`scope failed: ${error.message}`) }
  } })
  host.show(name)
  await sleep(5000)
  await rec('idle', { cpu: await cpu(host, name, 5000, sleep) })

  const doc = await openDoc(host, name, sleep)
  await sleep(8000)
  await host.shot(name, `${process.env.SPIKE_LABEL}-${name}-document.png`)
  await rec('document', { openMs: doc.ms, cpu: await cpu(host, name, 10_000, sleep) })

  // Hidden with setVisible(false), throttling still off (as Rocket creates its panes).
  host.hide(name, 'hidden')
  await sleep(1000)
  const hiddenPing = await host.ping(name, controlProbe(name))
  await sleep(29_000)
  await rec('setVisible(false) 30 s, throttling off', { ping: hiddenPing, cpu: await cpu(host, name, 10_000, sleep) })

  // Taken out of the window with throttling on: Chromium treats the page as hidden.
  host.hide(name, 'removed')
  host.contents(name).setBackgroundThrottling(true)
  await sleep(1000)
  const removedPing = await host.ping(name, controlProbe(name))
  await sleep(29_000)
  await rec('removed from window 30 s, throttling on', { ping: removedPing, ping30: await host.ping(name, controlProbe(name)), cpu: await cpu(host, name, 10_000, sleep) })

  // Chromium's own memory-pressure path: what a renderer gives back when told memory is short.
  const dbg = await host.cdp(name)
  await dbg.sendCommand('Memory.simulatePressureNotification', { level: 'critical' }).catch((e) => host.log(`pressure: ${e.message}`))
  await dbg.sendCommand('HeapProfiler.enable').catch(() => {})
  await dbg.sendCommand('HeapProfiler.collectGarbage').catch((e) => host.log(`gc: ${e.message}`))
  await sleep(5000)
  await rec('after pressure signal + GC')

  // The same squeeze the native plan uses: the renderer in its own scope with MemoryHigh.
  const squeezed = scoped
  if (squeezed) {
    setProp(unit, 'MemoryHigh=32M')
    await sleep(15_000)
    const pings = []
    for (let i = 0; i < 3; i++) { pings.push(await host.ping(name, controlProbe(name))); await sleep(1000) }
    await rec('squeezed MemoryHigh=32M, 15 s', { pings, cgroup: readFileSync(`/proc/${host.contents(name).getOSProcessId()}/cgroup`, 'utf8').trim() })
    setProp(unit, 'MemoryHigh=infinity')
  }

  // Show again: time from show to the page's next animation frame, then to a settled picture.
  host.contents(name).setBackgroundThrottling(false)
  const frame = host.js(name, 'new Promise((r) => requestAnimationFrame(() => r(performance.timeOrigin + performance.now())))')
  const shownAt = Date.now()
  host.show(name)
  const firstFrame = await Promise.race([frame, sleep(10_000).then(() => null)])
  const showMs = firstFrame ? Math.round(firstFrame - shownAt) : null
  await sleep(300)
  await host.shot(name, `${process.env.SPIKE_LABEL}-${name}-reshown.png`)
  const ping = await host.ping(name, controlProbe(name))
  await sleep(5000)
  await rec('shown again', { showToFrameMs: showMs, ping })

  // Discard: close the page, see what comes back, and how long a reopen takes (state is lost).
  const before = sum(host.allMem())
  await host.close(name)
  await sleep(3000)
  const after = sum(host.allMem())
  host.results.discard = { totalBeforeMB: before, totalAfterMB: after, freedMB: before - after }
  host.log('discard', host.results.discard)
  host.results.reopen = await host.open(name)
  host.show(name)
  await sleep(3000)
  await rec('reopened (document gone)')
}
