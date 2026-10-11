import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

// A synthetic long chat for the transcript benchmarks, written straight into a Craft Studio store.
// Its shape copies the real store this was measured against (Oct 2026: 262 turns, 5,215 items,
// 9.4 MB): about 20 items and 36 KB a turn, nine tenths of it tool output that the transcript
// keeps folded. The text is generated from a seed, so every run measures the same chat.

const LOREM = ('the transcript keeps every turn the provider saw and hands over only what it missed '
  + 'while each pane reads its own rows and a delta re-renders one of them never the list around it '
  + 'so a long chat should open as fast as a short one when the store sends only what is on screen').split(' ')

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function words(next: () => number, length: number): string {
  let text = ''
  while (text.length < length) text += LOREM[Math.floor(next() * LOREM.length)] + ' '
  return text.slice(0, length)
}

function code(next: () => number, length: number): string {
  const lines: string[] = []
  let size = 0
  while (size < length) {
    const line = `  const ${LOREM[Math.floor(next() * LOREM.length)]}${lines.length} = store.${LOREM[Math.floor(next() * LOREM.length)]}(chatId, ${Math.floor(next() * 1000)})`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

/** A final reply as models write them: a paragraph, a list, a code block and a closing line. */
function reply(next: () => number): string {
  return [
    words(next, 320),
    '',
    ...Array.from({ length: 4 }, (_, index) => `${index + 1}. **${words(next, 18).trim()}**: ${words(next, 110)}`),
    '',
    '```ts',
    code(next, 420),
    '```',
    '',
    `See \`src/host/store.ts:${Math.floor(next() * 300)}\`. ${words(next, 200)}`
  ].join('\n')
}

// Per turn, from the measured store: [kind, count, output bytes].
const TOOLS: Array<['command' | 'edit' | 'read' | 'search' | 'mcp', number, number]> = [
  ['command', 3.6, 3300], ['edit', 2.2, 4800], ['read', 2.2, 2600], ['search', 1.2, 250], ['mcp', 0.65, 1800]
]

export type LongChat = { chatId: string; turns: number; items: number; bytes: number }

/**
 * Write a chat of `turns` turns into the store at `path`, which must already have Craft Studio's schema
 * (open it once with `Store` first). Returns the chat id and how much was written.
 */
export function seedLongChat(path: string, options: { turns: number; cwd: string; title?: string; seed?: number }): LongChat {
  const next = random(options.seed ?? 1)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  const chatId = randomUUID()
  const start = Date.now() - options.turns * 60_000
  const putItem = db.prepare('INSERT INTO items (chat_id, id, turn_id, data) VALUES (?, ?, ?, ?)')
  const putTurn = db.prepare(
    'INSERT INTO turns (id, chat_id, provider, model, status, error, handoff_turns, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)'
  )
  let items = 0
  let bytes = 0
  const put = (turnId: string, item: Record<string, unknown>): void => {
    const data = JSON.stringify({ ...item, turnId })
    putItem.run(chatId, String(item.id), turnId, data)
    items++
    bytes += data.length
  }
  db.exec('BEGIN')
  db.prepare('INSERT INTO chats (id, title, cwd, last_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, options.title ?? `Long chat (${options.turns} turns)`, options.cwd, 'claude', start, Date.now())
  for (let index = 0; index < options.turns; index++) {
    const turnId = randomUUID()
    const at = start + index * 60_000
    putTurn.run(turnId, chatId, 'claude', 'ui-default', 'completed', at, at + 45_000)
    put(turnId, { type: 'user', id: `${turnId}:user`, text: `Turn ${index + 1}: ${words(next, 420)}` })
    const steps: Array<Record<string, unknown>> = []
    for (let r = 0; r < 5; r++) steps.push({ type: 'reasoning', text: words(next, 500), streaming: false })
    for (let a = 0; a < 2; a++) steps.push({ type: 'assistant', text: words(next, 300), streaming: false })
    for (const [kind, count, size] of TOOLS) {
      const n = Math.floor(count) + (next() < count % 1 ? 1 : 0)
      for (let t = 0; t < n; t++) {
        steps.push({ type: 'tool', kind, label: `${kind} ${words(next, 60).trim()}`, status: next() < 0.03 ? 'failed' : 'done', output: code(next, size) })
      }
    }
    // Shuffled so tools, thinking and narration interleave the way a real turn does.
    for (let s = steps.length - 1; s > 0; s--) {
      const j = Math.floor(next() * (s + 1))
      ;[steps[s], steps[j]] = [steps[j]!, steps[s]!]
    }
    steps.forEach((step, s) => put(turnId, { ...step, id: `${turnId}:${s}` }))
    put(turnId, { type: 'assistant', id: `${turnId}:reply`, text: `Reply ${index + 1}. ${reply(next)}`, streaming: false })
  }
  db.exec('COMMIT')
  db.close()
  return { chatId, turns: options.turns, items, bytes }
}
