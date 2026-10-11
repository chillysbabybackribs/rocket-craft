import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Chat, Turn } from '../shared/types.ts'
import { Store } from './store.ts'

const chat: Chat = { id: 'c1', title: 'Chat', cwd: '/tmp', lastProvider: null, createdAt: 1, updatedAt: 1 }

function turn(id: string, provider: Turn['provider']): Turn {
  return { id, chatId: 'c1', provider, model: null, status: 'completed', error: null, handoffTurns: 0, changes: null, tokens: null, sources: null, startedAt: 1, endedAt: 2 }
}

test('an item updated in place keeps its first position', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  store.createTurn(turn('t1', 'claude'))
  store.putItem('c1', { type: 'assistant', id: 'a', turnId: 't1', text: 'par', streaming: true })
  store.putItem('c1', { type: 'notice', id: 'n', turnId: 't1', text: 'note', tone: 'info' })
  store.putItem('c1', { type: 'assistant', id: 'a', turnId: 't1', text: 'partial, then whole', streaming: false })
  const items = store.snapshot('c1')!.items
  assert.deepEqual(items.map((item) => item.id), ['a', 'n'])
  assert.equal(items[0]!.type === 'assistant' && items[0].text, 'partial, then whole')
})

test('a provider is owed exactly the turns after the one its session last saw', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  const first = store.createTurn(turn('t1', 'claude'))
  store.setSession('c1', 'claude', { sessionId: 's-claude', seenTurnSeq: first.seq })
  store.createTurn(turn('t2', 'codex'))
  store.createTurn(turn('t3', 'cursor'))
  assert.deepEqual(store.turnsAfter('c1', store.session('c1', 'claude').seenTurnSeq).map((entry) => entry.id), ['t2', 't3'])
  // A provider that has never answered here has seen nothing.
  assert.deepEqual(store.session('c1', 'antigravity'), { sessionId: null, seenTurnSeq: 0 })
  assert.equal(store.turnsAfter('c1', 0).length, 3)
})

test('deleting a chat removes its turns, items and sessions', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  store.createTurn(turn('t1', 'claude'))
  store.putItem('c1', { type: 'user', id: 'u', turnId: 't1', text: 'hi' })
  store.setSession('c1', 'claude', { sessionId: 's', seenTurnSeq: 1 })
  store.deleteChat('c1')
  assert.equal(store.snapshot('c1'), null)
  assert.deepEqual(store.turns('c1'), [])
  assert.deepEqual(store.session('c1', 'claude'), { sessionId: null, seenTurnSeq: 0 })
})

test('a store made before the later columns gains them, and its turns still read and write', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'rocket-store-')), 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT, status TEXT NOT NULL, error TEXT, handoff_turns INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER)`)
  old.close()
  const store = new Store(path)
  store.createChat(chat)
  store.createTurn(turn('t1', 'codex'))
  assert.equal(store.turns('c1')[0]!.provider, 'codex')
  store.putItem('c1', { type: 'user', id: 'u', turnId: 't1', text: 'hi' })
  assert.deepEqual(store.turnItems('c1', 't1'), [{ type: 'user', id: 'u', turnId: 't1', text: 'hi' }])
  store.close()
})

test("a turn's sources are saved with it, and a turn without them reads as null", () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  const stored = store.createTurn(turn('t1', 'claude'))
  assert.equal(store.turn('t1')!.sources, null)
  const sources = { opened: [{ url: 'https://a.example/x', via: 'browser' as const }], cited: [{ url: 'https://a.example/x', opened: true }, { url: 'https://b.example/', opened: false }] }
  store.updateTurn({ ...stored, sources })
  assert.deepEqual(store.turn('t1')!.sources, sources)
})

test("a turn's tokens are saved with it, and a turn without them reads as null", () => {
  const store = new Store(':memory:')
  store.createChat({ id: 'c1', title: 'chat', cwd: '/work', lastProvider: null, createdAt: 1, updatedAt: 1 })
  const stored = store.createTurn(turn('t1', 'claude'))
  assert.equal(store.turn('t1')!.tokens, null)
  const tokens = { input: 1_200, cached: 1_000, output: 30, context: 1_100, contextWindow: 200_000 }
  store.updateTurn({ ...stored, tokens })
  assert.deepEqual(store.turn('t1')!.tokens, tokens)
})

test('a handoff read returns the turns in a range with their own items, in order', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  const first = store.createTurn(turn('t1', 'claude'))
  const second = store.createTurn(turn('t2', 'codex'))
  store.createTurn(turn('t3', 'cursor'))
  store.putItem('c1', { type: 'user', id: 'u1', turnId: 't1', text: 'one' })
  store.putItem('c1', { type: 'user', id: 'u2', turnId: 't2', text: 'two' })
  store.putItem('c1', { type: 'user', id: 'u3', turnId: 't3', text: 'three' })
  store.putItem('c1', { type: 'assistant', id: 'a2', turnId: 't2', text: 'reply two', streaming: false })
  const read = store.turnsWithItems('c1', first.seq)
  assert.deepEqual(read.map(({ turn, items }) => [turn.id, items.map((item) => item.id)]), [['t2', ['u2', 'a2']], ['t3', ['u3']]])
  assert.deepEqual(store.turnsWithItems('c1', 0, second.seq).map(({ turn }) => turn.id), ['t1'])
  assert.deepEqual(store.turnsWithItems('c1', 99), [])
})

test('the running and the last settled turn are found without reading the chat', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  store.createTurn(turn('t1', 'claude'))
  store.createTurn({ ...turn('t2', 'codex'), status: 'running', endedAt: null })
  assert.equal(store.runningTurn('c1')?.id, 't2')
  assert.equal(store.runningTurn('c1', 'codex')?.id, 't2')
  assert.equal(store.runningTurn('c1', 'claude'), undefined)
  assert.equal(store.lastSettledTurn('c1')?.id, 't1')
})

test('the attachment sweep keeps what user messages and queues hold, whatever else mentions attachments', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  store.createTurn(turn('t1', 'claude'))
  const image = (id: string) => ({ id, kind: 'image' as const, name: `${id}.png`, mimeType: 'image/png', size: 1, width: 1, height: 1 })
  for (const id of ['sent', 'queued', 'loose']) store.saveAttachment(image(id) as never)
  store.putItem('c1', { type: 'user', id: 'u', turnId: 't1', text: 'see', attachments: [image('sent') as never] })
  store.putItem('c1', { type: 'tool', id: 'x', turnId: 't1', kind: 'read', label: 'f', status: 'done', output: '{"attachments":[{"id":"loose"}]}' })
  store.saveQueue('c1', [{ id: 'q', provider: 'claude', model: null, text: '', attachments: [image('queued') as never] }])
  assert.deepEqual(store.unusedAttachments([], Date.now() + 1).map((attachment) => attachment.id), ['loose'])
})

test('a chat opens with its newest page of turns, and earlier pages come on request until none are left', () => {
  const store = new Store(':memory:')
  store.createChat(chat)
  for (let index = 1; index <= 45; index++) {
    store.createTurn(turn(`t${index}`, 'claude'))
    store.putItem('c1', { type: 'user', id: `u${index}`, turnId: `t${index}`, text: `message ${index}` })
  }
  const opened = store.snapshot('c1')!
  assert.deepEqual(opened.turns.map((entry) => entry.id), Array.from({ length: 20 }, (_, index) => `t${index + 26}`))
  assert.deepEqual(opened.items.map((item) => item.id), Array.from({ length: 20 }, (_, index) => `u${index + 26}`))
  assert.equal(opened.hasOlder, true)
  const second = store.olderTurns('c1', 't26')
  assert.deepEqual([second.turns[0]!.id, second.turns.at(-1)!.id, second.items.length, second.hasOlder], ['t6', 't25', 20, true])
  const last = store.olderTurns('c1', 't6')
  assert.deepEqual([last.turns.map((entry) => entry.id), last.hasOlder], [['t1', 't2', 't3', 't4', 't5'], false])
  assert.deepEqual(store.olderTurns('c1', 'not-a-turn'), { turns: [], items: [], hasOlder: false })
  assert.equal(store.snapshot('c1', 100)!.hasOlder, false)
})
