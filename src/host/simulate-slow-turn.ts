/**
 * Exercise slow-turn detection against the real journal file (same logic as the running host).
 * Six fast turns establish a baseline; the seventh is far slower and should log warn/slow-turn.
 *
 * Usage:
 *   CRAFT_DATA_DIR="$HOME/.config/Craft Studio" npm run simulate:slow-turn
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Journal, type TimingReading } from './journal.ts'

const dataDir = process.env.CRAFT_DATA_DIR || join(homedir(), '.config', 'Craft Studio')
const journal = new Journal(join(dataDir, 'journal.jsonl'))

const timing = (firstTextMs: number): TimingReading => ({
  chatId: 'slow-turn-simulation',
  provider: 'sim',
  model: 'slow-turn-demo',
  status: 'completed',
  firstEventMs: 100,
  firstTextMs,
  totalMs: firstTextMs + 500
})

const FAST_MS = 2_000
const SLOW_MS = 30_000

console.log(`Journal: ${journal.path}`)
console.log(`Baseline: 6 × ${FAST_MS}ms first text, then 1 × ${SLOW_MS}ms`)

for (let i = 0; i < 6; i++) journal.noteTiming(timing(FAST_MS))
journal.noteTiming(timing(SLOW_MS))

const slow = journal.read({ severity: 'warn', limit: 20 }).filter((entry) => entry.kind === 'slow-turn')
const last = slow.at(-1)
if (!last) {
  console.error('Expected a slow-turn warning; none found.')
  process.exit(1)
}
console.log(`\nOK — slow-turn logged:\n  ${last.message}`)
