import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Chat } from '../shared/types.ts'
import { Store } from './store.ts'
import { memoryTools } from './tools/memory.ts'
import { renderMap, workspaceContext } from './workspace.ts'

test('a small project is mapped whole, one line per folder', () => {
  assert.equal(
    renderMap(['README.md', 'src/b.ts', 'src/a/x.ts', 'package.json']),
    './: README.md, package.json\nsrc/: b.ts\nsrc/a/: x.ts'
  )
})

test('a large project keeps its upper folders and counts what lies deeper', () => {
  const files = ['README.md', ...Array.from({ length: 400 }, (_, i) => `src/pkg${i % 20}/deep/file-number-${i}.ts`), 'src/index.ts']
  const map = renderMap(files, 600)
  assert.ok(map.length <= 600, `map was ${map.length} characters`)
  assert.match(map, /^\.\/: README\.md$/m)
  assert.match(map, /^src\/: index\.ts$/m)
  assert.match(map, /^src\/pkg7\/: \(\+20 deeper\)$/m)
})

function chatIn(store: Store, id: string, cwd: string): Chat {
  const chat: Chat = { id, title: 't', cwd, lastProvider: null, createdAt: 1, updatedAt: 1 }
  store.createChat(chat)
  return chat
}

test('a note saved by one provider reaches the others: at once in a going session, and at the start of a new one', async () => {
  const store = new Store(':memory:')
  // A folder that does not exist has no map, so only the notes are in play.
  chatIn(store, 'c1', '/no/such/folder')
  chatIn(store, 'c2', '/no/such/folder')
  chatIn(store, 'c3', '/elsewhere')
  const context = workspaceContext(store)
  const [remember] = memoryTools(store)
  const save = async (args: Record<string, unknown>, chatId: string | null) =>
    (await remember!.run(args, { provider: 'claude', chatId })).content.map((part) => (part.type === 'text' ? part.text : '')).join('')

  assert.equal(await context('c1', 'claude', true), null, 'nothing to say about an empty folder with no notes')
  assert.equal(await context('c1', 'codex', true), null)
  assert.equal(await save({ note: 'Tests run with npm test.' }, 'c1'), 'Saved as m1.')

  assert.equal(await context('c1', 'claude', false), null, 'the session that wrote a note is not told it back')
  assert.match((await context('c1', 'codex', false))!, /m1: Tests run with npm test\./)
  assert.equal(await context('c1', 'codex', false), null, 'and is told once')
  assert.match((await context('c2', 'cursor', true))!, /m1: Tests run with npm test\./)
  assert.equal(await context('c3', 'cursor', true), null, 'notes belong to their folder')

  assert.equal(await save({ note: 'Tests run with npm run check.', replaces: 'm1' }, 'c2'), 'Removed m1. Saved as m2.')
  assert.deepEqual(store.notes('/no/such/folder').map((note) => note.text), ['Tests run with npm run check.'])
  assert.match(await save({ note: 'x' }, null), /could not tell which chat/)
})

test('a worktree chat sees and saves the main folder\'s notes', async () => {
  const store = new Store(':memory:')
  chatIn(store, 'main', '/no/such/main')
  chatIn(store, 'tree', '/no/such/tree')
  const home = (cwd: string): string => (cwd === '/no/such/tree' ? '/no/such/main' : cwd)
  const context = workspaceContext(store, home)
  const [remember] = memoryTools(store, home)
  store.addNote({ cwd: '/no/such/main', text: 'Use npm test.', provider: 'claude', chatId: 'main' })
  assert.match((await context('tree', 'claude', true))!, /m1: Use npm test\./)
  await remember!.run({ note: 'Found from the copy.' }, { provider: 'claude', chatId: 'tree' })
  assert.deepEqual(store.notes('/no/such/main').map((note) => note.text), ['Use npm test.', 'Found from the copy.'])
  assert.deepEqual(store.notes('/no/such/tree'), [])
})
