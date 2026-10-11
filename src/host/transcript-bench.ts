import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Store } from './store.ts'
import { buildHandoff, type MissedTurn } from './handoff.ts'
import { withoutOutput } from './hub.ts'
import { seedLongChat } from '../../tests/fixtures/long-chat.ts'

// The host's half of the long-chat benchmark (`npm run bench:transcript`): how long the store
// takes to give the window a chat, how much it sends, and the other reads that grow with a
// chat's length. The window's half, opening and scrolling in the real app, is
// tests/ui/long-chat.spec.ts. Results go to .artifacts/bench/ so runs can be compared.

const SIZES = (process.env.BENCH_TURNS ?? '45,250,1000').split(',').map(Number)
const RUNS = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function time(fn: () => unknown): number {
  const runs: number[] = []
  for (let index = 0; index < RUNS; index++) {
    const start = performance.now()
    fn()
    runs.push(performance.now() - start)
  }
  return Math.round(median(runs) * 10) / 10
}

const rows: Array<Record<string, number>> = []
for (const turns of SIZES) {
  const folder = mkdtempSync(join(tmpdir(), 'rocket-bench-'))
  try {
    const path = join(folder, 'rocket.db')
    new Store(path).close()
    const seeded = seedLongChat(path, { turns, cwd: folder })
    const store = new Store(path)
    // What `chat.open` sends: the newest page, its finished tool output left for when a step is opened.
    const snapshot = store.snapshot(seeded.chatId)!
    const sent = { ...snapshot, items: snapshot.items.map(withoutOutput) }
    const whole = JSON.stringify(snapshot).length
    rows.push({
      turns,
      items: seeded.items,
      'stored MB': Math.round(seeded.bytes / 1e5) / 10,
      'open: store read ms': time(() => store.snapshot(seeded.chatId)),
      'open: page KB': Math.round(whole / 1e3),
      'open: sent KB': Math.round(JSON.stringify(sent).length / 1e3),
      'open: clone ms': time(() => structuredClone(sent)),
      'running turn ms': time(() => store.runningTurn(seeded.chatId)),
      'attachment sweep ms': time(() => store.unusedAttachments([], 0)),
      'full handoff ms': time(() => {
        // As the hub reads a handoff (`handoffFor`): one read for every turn the provider missed.
        const missed: MissedTurn[] = store.turnsWithItems(seeded.chatId, 0).map(({ turn, items }) => ({
          provider: turn.provider, model: turn.model, status: turn.status, items
        }))
        buildHandoff(missed, undefined, folder)
      })
    })
    store.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

console.table(rows)
const out = resolve('.artifacts/bench')
mkdirSync(out, { recursive: true })
const file = join(out, `transcript-host-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(rows, null, 2))
console.log(`Saved ${file}`)
