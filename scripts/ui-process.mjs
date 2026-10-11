import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// The UI runner is Linux-only. Electron starts a detached process group of its own, so
// killing just npm's/xvfb-run's group is not enough. Keep process birth times with the
// discovered descendants so escalation cannot target a PID that has been reused.
async function processInfo(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    return { pid: Number(pid), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), born: fields[19] }
  } catch { return null }
}

async function discover(root, known) {
  const all = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(processInfo))).filter(Boolean)
  const live = new Set(all.filter(p => known.get(p.pid)?.born === p.born).map(p => p.pid))
  let changed = true
  while (changed) {
    changed = false
    for (const p of all) {
      if (!live.has(p.pid) && (live.has(p.parent) || p.group === root)) {
        known.set(p.pid, p)
        live.add(p.pid)
        changed = true
      }
    }
  }
  return all.filter(p => live.has(p.pid) && p.state !== 'Z')
}

async function signalOwned(processes, signal) {
  for (const p of processes) {
    const current = await processInfo(p.pid)
    if (current?.born !== p.born || current.state === 'Z') continue
    try { process.kill(p.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

async function stopTree(child, graceMs, known = new Map()) {
  const root = await processInfo(child.pid)
  if (root && !known.has(root.pid)) known.set(root.pid, root)
  const signalled = new Set()
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    const live = await discover(child.pid, known)
    if (!live.length) return
    const fresh = live.filter(p => !signalled.has(`${p.pid}:${p.born}`))
    await signalOwned(fresh, 'SIGTERM')
    for (const p of fresh) signalled.add(`${p.pid}:${p.born}`)
    await delay(25)
  }
  await signalOwned(await discover(child.pid, known), 'SIGKILL')
  // Await death, not just successful delivery of SIGKILL, before writing the final report.
  const killedBy = Date.now() + 2_000
  while ((await discover(child.pid, known)).length) {
    if (Date.now() > killedBy) throw new Error('A UI-check subprocess did not terminate after SIGKILL.')
    await delay(25)
  }
}

export async function runCommand(command, args, { cwd, env, signal, onOutput, onStart, cleanupOnExit = false, graceMs = 1_000 }) {
  if (signal.aborted) return 1
  const child = spawn(command, args, { cwd, env, detached: true, stdio: [onStart ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => onOutput(data))
  const known = new Map()
  let tracking = Promise.resolve()
  let tracker
  if (cleanupOnExit && child.pid) {
    const poll = async () => {
      const root = await processInfo(child.pid)
      if (root && !known.has(root.pid)) known.set(root.pid, root)
      await discover(child.pid, known)
    }
    tracking = poll()
    tracker = setInterval(() => { tracking = tracking.then(poll).catch(() => {}) }, 250)
    tracker.unref()
  }
  let stopping
  // Observe rejection immediately; the main await still reports cleanup failures.
  const stop = () => {
    if (child.pid) {
      stopping ??= tracking.then(() => stopTree(child, graceMs, known))
      void stopping.catch(() => {})
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    try { onStart?.(child) } catch (error) { stop(); throw error }
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    if (cleanupOnExit) stop()
    if (stopping) await stopping
    return signal.aborted ? 1 : result
  } finally {
    clearInterval(tracker)
    signal.removeEventListener('abort', stop)
    if (stopping) await stopping
  }
}
