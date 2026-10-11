// What each way of hiding costs and whether the app still answers: shown, parked off the window
// edge (rocketv1's conceal), setVisible(false), and removed from the window. CPU of the renderer
// and the GPU process over 10 s in each, and a control call (FilmCraft's API, else a script).
import { readFileSync } from 'node:fs'

function ticks(pid) {
  try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]) } catch { return null }
}

export async function run(host, { sleep }) {
  const apps = (process.env.SPIKE_APPS || 'photocraft,gridcraft,filmcraft').split(',')
  const out = host.results.parked = {}
  for (const name of apps) { await host.open(name, { show: false }); host.hide(name, 'removed') }
  for (const name of apps) {
    const rows = out[name] = []
    const probe = name === 'filmcraft' ? `filmcraft.request('ui.inspect', {}).then(() => 'api answered')` : `'script answered'`
    for (const mode of ['shown', 'parked', 'hidden', 'removed']) {
      if (mode === 'shown') host.show(name, 'removed')
      else { host.show(name, 'removed'); await sleep(500); host.hide(name, mode) }
      host.contents(name).setBackgroundThrottling(mode === 'removed')
      await sleep(3000)
      const pids = { renderer: host.contents(name).getOSProcessId(), gpu: host.allMem().find((m) => m.type === 'GPU')?.pid }
      const before = Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, ticks(p)]))
      await sleep(10_000)
      const cpu = Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, Math.round((ticks(p) - before[k]) / 10 * 10) / 10]))
      const ping = await host.ping(name, probe, 8000)
      const row = { mode, cpu, ping, rssMB: host.mem(name).rssMB }
      rows.push(row)
      host.log(name, row)
    }
    host.hide(name, 'removed')
  }
}
