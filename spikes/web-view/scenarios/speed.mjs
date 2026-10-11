// FilmCraft web: import a 10 s 720p clip, make a sequence from it, export it as H.264 and time the
// export until its job finishes. The same steps run against the native build over its TCP control
// channel (speed-native.mjs) for a like-for-like comparison. Then the export is repeated with the
// view taken out of the window, to see whether a hidden web app keeps working.
import { readFileSync } from 'node:fs'

const ticks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]) } catch { return null } }

export async function run(host, { sleep }) {
  const out = host.results.speed = {}
  await host.open('filmcraft')
  host.show('filmcraft')
  await sleep(2000)
  out.setup = await host.js('filmcraft', `(async () => {
    const imp = await filmcraft.importUrl('/__media/clip-720p-10s.mp4', 'clip.mp4')
    const seq = await filmcraft.execute('file.newSequence', { fromItem: imp.items[0] })
    return JSON.parse(JSON.stringify({ imp, seq, info: filmcraft.info() }))
  })()`)
  await sleep(3000)

  const exportOnce = async (label, path) => host.js('filmcraft', `(async () => {
    const t0 = performance.now()
    const started = await filmcraft.execute('file.exportMedia', { format: 'h264', crf: 23, path: ${JSON.stringify(path)} })
    let jobs, polls = 0
    for (;;) {
      jobs = await filmcraft.execute('jobs.list', {})
      const list = Array.isArray(jobs) ? jobs : (jobs.jobs || [])
      const active = list.filter((j) => !/done|finished|complete|failed|cancel/i.test(String(j.state || j.status || '')))
      if (!active.length || performance.now() - t0 > 600000) break
      polls++
      await new Promise((r) => setTimeout(r, 250))
    }
    const file = filmcraft.files().find((f) => f.path === ${JSON.stringify(path)})
    return JSON.parse(JSON.stringify({ label: ${JSON.stringify(label)}, ms: Math.round(performance.now() - t0), started, jobs, polls, file }))
  })()`)

  const pid = host.contents('filmcraft').getOSProcessId()
  const gpu = host.allMem().find((m) => m.type === 'GPU')?.pid
  const before = [ticks(pid), ticks(gpu)]
  out.shown = await exportOnce('shown', '/exports/shown.mp4')
  out.shown.rendererCpuMs = (ticks(pid) - before[0]) * 10
  out.shown.gpuCpuMs = (ticks(gpu) - before[1]) * 10
  out.shown.loadavg = readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')
  host.log('export shown', out.shown)
  await host.shot('filmcraft', `${process.env.SPIKE_LABEL}-filmcraft-exported.png`)

  // Hidden (out of the window, throttled): does the export still advance?
  host.contents('filmcraft').setBackgroundThrottling(true)
  host.hide('filmcraft', 'removed')
  await sleep(1000)
  const hidden = exportOnce('removed', '/exports/hidden.mp4')
  const progress = []
  for (let i = 0; i < 6; i++) {
    await sleep(5000)
    progress.push(await host.js('filmcraft', `filmcraft.execute('jobs.list', {}).then((j) => JSON.parse(JSON.stringify(j)))`).catch((e) => String(e)))
  }
  out.hiddenProgress = progress
  out.hidden = await Promise.race([hidden, sleep(120_000).then(() => 'not finished after 150 s hidden')])
  host.log('export hidden', out.hidden)
}
