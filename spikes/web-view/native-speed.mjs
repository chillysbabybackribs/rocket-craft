// The native FilmCraft side of the speed comparison: start the desktop build with its control
// channel on a private display, import the same clip, make a sequence from it, export H.264 with
// the same settings and time the export until its job finishes. Also records the app's memory.
// Usage: DISPLAY=:94 node native-speed.mjs <label> [taskset cpu list]
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BIN = join(ROOT, 'downloads/filmcraft-native/x/filmcraft-0.6.0-linux-x86_64/bin/filmcraft')
const label = process.argv[2] || 'native'
const cpus = process.argv[3]
const port = 7900 + Math.floor(Math.random() * 90)
const outDir = join(ROOT, 'results', 'native-exports')
mkdirSync(outDir, { recursive: true })
const home = join(ROOT, 'results', `native-home-${label}`)
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })

const args = ['--control', String(port)]
const child = cpus
  ? spawn('taskset', ['-c', cpus, BIN, ...args], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') }, stdio: 'ignore' })
  : spawn(BIN, args, { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') }, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rss = (pid) => { try { const s = readFileSync(`/proc/${pid}/status`, 'utf8'); return Math.round(Number(s.match(/VmRSS:\s+(\d+)/)[1]) / 1024) } catch { return null } }

async function client() {
  const t0 = Date.now()
  for (;;) {
    try {
      const sock = await new Promise((ok, fail) => { const s = connect(port, '127.0.0.1', () => ok(s)); s.once('error', fail) })
      return { sock, ms: Date.now() - t0 }
    } catch { if (Date.now() - t0 > 30000) throw new Error('control channel never answered'); await sleep(50) }
  }
}

const result = { label, cpus: cpus || 'all', port }
try {
  const t0 = Date.now()
  const { sock } = await client()
  let buffer = ''
  const pending = []
  sock.on('data', (d) => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); pending.shift()?.(JSON.parse(line)) } })
  let id = 0
  const call = (method, params) => new Promise((ok) => { pending.push(ok); sock.write(JSON.stringify({ id: ++id, method, params }) + '\n') })
  const exec = (command, params) => call('engine.execute', { command, params })
  await call('ui.inspect', {})
  result.startToControlMs = Date.now() - t0
  await sleep(3000)
  result.idleRssMB = rss(child.pid)
  const imp = await exec('file.import', { paths: [join(ROOT, 'media/clip-720p-10s.mp4')] })
  result.import = imp
  const items = imp.result?.items || imp.result?.imported || []
  const item = typeof items[0] === 'object' ? items[0].id : items[0]
  result.seq = await exec('file.newSequence', { fromItem: item })
  await sleep(3000)
  result.documentRssMB = rss(child.pid)
  const path = join(outDir, `${label}.mp4`)
  rmSync(path, { force: true })
  const ticks = () => { const f = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]) }
  const t0cpu = ticks()
  const e0 = Date.now()
  result.started = await exec('file.exportMedia', { format: 'h264', crf: 23, path })
  let jobs
  for (;;) {
    jobs = await exec('jobs.list', {})
    const list = Array.isArray(jobs.result) ? jobs.result : (jobs.result?.jobs || [])
    const active = list.filter((j) => !/done|finished|complete|failed|cancel/i.test(String(j.state || j.status || '')))
    if (!active.length || Date.now() - e0 > 600000) break
    await sleep(250)
  }
  result.exportMs = Date.now() - e0
  result.cpuMs = (ticks() - t0cpu) * 10
  result.loadavg = readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')
  result.jobs = jobs
  result.peakRssMB = rss(child.pid)
  try { result.fileBytes = readFileSync(path).length } catch { result.fileBytes = null }
  await call('app.quit', {}).catch(() => {})
} catch (error) {
  result.error = String(error.stack || error)
} finally {
  await sleep(500)
  try { child.kill('SIGTERM') } catch {}
  await sleep(500)
  try { process.kill(child.pid, 0); child.kill('SIGKILL') } catch {}
}
writeFileSync(join(ROOT, 'results', `native-speed-${label}.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 1).slice(0, 3000))
process.exit(0)
