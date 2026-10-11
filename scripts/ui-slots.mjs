// Shared UI check concurrency: lock files under the OS temp dir so worktrees share one pool.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export const DEFAULT_SLOT_DIR = join(tmpdir(), 'rocket-ui-slots')

const POLL_MS = 3_000
const WAIT_LINE = 'Waiting for a UI check slot…'

/** One slot per four cores, at least one. `CRAFT_UI_SLOTS` overrides. */
export function slotCount(env = process.env) {
  const override = env.CRAFT_UI_SLOTS
  if (override !== undefined && override !== '') {
    const n = Number.parseInt(String(override), 10)
    if (Number.isFinite(n) && n >= 1) return n
  }
  return Math.max(1, Math.floor(cpus().length / 4))
}

export function isExclusiveUiCheck(argv) {
  const args = argv.filter(arg => arg !== '--visible')
  if (args.length === 0) return true
  return args.some(arg => /long-chat|orchestra-stress/.test(arg))
}

function slotPath(dir, index) {
  return join(dir, `slot-${index}.json`)
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'
  }
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function tryTakeSlot(dir, index, pid) {
  const path = slotPath(dir, index)
  if (existsSync(path)) {
    const lock = await readLock(path)
    if (lock && pidAlive(Number(lock.pid))) return false
    try { await unlink(path) } catch { return false }
  }
  const body = JSON.stringify({ pid, started: Date.now() })
  try {
    await writeFile(path, body, { flag: 'wx' })
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

async function tryAcquire({ dir, count, exclusive, pid }) {
  if (exclusive) {
    const taken = []
    for (let i = 0; i < count; i++) {
      if (!(await tryTakeSlot(dir, i, pid))) {
        for (const index of taken) await unlink(slotPath(dir, index)).catch(() => {})
        return null
      }
      taken.push(i)
    }
    return taken
  }
  for (let i = 0; i < count; i++) {
    if (await tryTakeSlot(dir, i, pid)) return [i]
  }
  return null
}

/**
 * Hold one slot, or every slot when `exclusive`. Calls `release()` on exit, SIGINT and SIGTERM.
 * @param {{ exclusive?: boolean, dir?: string, count?: number, pollMs?: number, env?: NodeJS.ProcessEnv }} options
 */
export async function acquireUiSlots(options = {}) {
  const env = options.env ?? process.env
  const dir = options.dir ?? DEFAULT_SLOT_DIR
  const count = options.count ?? slotCount(env)
  const exclusive = options.exclusive === true
  const pollMs = options.pollMs ?? POLL_MS
  const pid = process.pid
  await mkdir(dir, { recursive: true })

  let waitingPrinted = false
  let held = null
  while (!held) {
    held = await tryAcquire({ dir, count, exclusive, pid })
    if (!held) {
      if (!waitingPrinted) {
        console.log(WAIT_LINE)
        waitingPrinted = true
      }
      await delay(pollMs)
    }
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    await Promise.all(held.map(index => unlink(slotPath(dir, index)).catch(() => {})))
  }

  const syncRelease = () => {
    if (released) return
    released = true
    for (const index of held) {
      try { unlinkSync(slotPath(dir, index)) } catch {}
    }
  }
  const onSignal = () => { void release() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('exit', syncRelease)

  return { slots: held, exclusive, release }
}
