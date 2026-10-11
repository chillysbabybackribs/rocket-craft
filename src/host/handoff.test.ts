import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from '../shared/types.ts'
import { buildHandoff, stripHandoff, withHandoff, type MissedTurn } from './handoff.ts'

function turn(provider: MissedTurn['provider'], user: string, reply: string, extra: Item[] = []): MissedTurn {
  return {
    provider,
    model: 'm1',
    status: 'completed',
    items: [
      { type: 'user', id: 'u', turnId: 't', text: user },
      { type: 'reasoning', id: 'r', turnId: 't', text: 'private thinking', streaming: false },
      ...extra,
      { type: 'assistant', id: 'a', turnId: 't', text: reply, streaming: false }
    ]
  }
}

test('nothing missed means no handoff', () => {
  assert.equal(buildHandoff([]), null)
  assert.equal(withHandoff(null, 'hello'), 'hello')
})

test('a handoff carries user and assistant text, tool lines, and no reasoning or tool output', () => {
  const handoff = buildHandoff([
    turn('codex', 'fix the bug', 'Fixed in parser.ts.', [
      { type: 'tool', id: 'x', turnId: 't', kind: 'command', label: 'npm test', status: 'failed', output: 'SECRET OUTPUT' }
    ])
  ])!
  assert.equal(handoff.turns, 1)
  assert.match(handoff.text, /Turn answered by Codex \(m1\)/)
  assert.match(handoff.text, /fix the bug/)
  assert.match(handoff.text, /Fixed in parser\.ts\./)
  assert.match(handoff.text, /- command: npm test \(failed\)/)
  assert.doesNotMatch(handoff.text, /private thinking|SECRET OUTPUT/)
  assert.deepEqual(handoff.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(handoff.messages[0]!.text, 'fix the bug')
})

test('a question the user has not answered is named as still open; an answered one is not flagged', () => {
  const question = (answer: string | null): Item => ({
    type: 'question', id: 'q', turnId: 't', text: 'Which database?', answer, recommended: 0,
    options: [{ label: 'Postgres', detail: 'Shared.' }, { label: 'SQLite', detail: 'Local.' }]
  })
  assert.match(buildHandoff([turn('codex', 'build it', 'Scaffolded.', [question(null)])])!.text, /- asked the user: Which database\? \(no answer yet\)/)
  assert.match(buildHandoff([turn('codex', 'build it', 'Scaffolded.', [question('SQLite')])])!.text, /- asked the user: Which database\?\n/)
})

test('the user sees their own words when a message went out with a handoff in front', () => {
  const handoff = buildHandoff([turn('claude', 'a', 'b')])
  assert.equal(stripHandoff(withHandoff(handoff, 'what next?')), 'what next?')
})

test('an oversized handoff is cut to the budget and keeps the newest turn whole', () => {
  const handoff = buildHandoff([
    turn('codex', 'old question', 'x'.repeat(50_000)),
    turn('cursor', 'new question', 'the newest answer')
  ], 5_000)!
  assert.ok(handoff.text.length < 6_000, `handoff was ${handoff.text.length} characters`)
  assert.match(handoff.text, /characters omitted/)
  assert.match(handoff.text, /the newest answer/)
  assert.match(handoff.text, /old question/)
})

test('files a turn touched are named once each, relative to the chat folder, edits ahead of reads', () => {
  const tool = (id: string, kind: 'read' | 'edit' | 'command', label: string, status: 'done' | 'failed' = 'done'): Item =>
    ({ type: 'tool', id, turnId: 't', kind, label, status, output: '' })
  const handoff = buildHandoff([
    turn('claude', 'tidy up', 'Done.', [
      tool('1', 'read', '/work/src/a.ts'),
      tool('2', 'read', '/work/src/a.ts'),
      tool('3', 'read', '/work/src/b.ts'),
      tool('4', 'edit', '/work/src/b.ts'),
      tool('5', 'read', '/etc/hosts'),
      tool('6', 'read', '/work/missing.ts', 'failed'),
      tool('7', 'command', 'npm test')
    ])
  ], undefined, '/work')!
  assert.match(handoff.text, /- edited: src\/b\.ts\n- read: src\/a\.ts, \/etc\/hosts\n- read: \/work\/missing\.ts \(failed\)\n- command: npm test/)
})

test('a handoff carries what a turn concluded, not what it said between tool calls', () => {
  const handoff = buildHandoff([{
    provider: 'claude', model: null, status: 'completed', items: [
      { type: 'user', id: 'u', turnId: 't', text: 'check the tests' },
      { type: 'assistant', id: 'a1', turnId: 't', text: 'Let me run the tests first.', streaming: false },
      { type: 'tool', id: 'x', turnId: 't', kind: 'command', label: 'npm test', status: 'done', output: '' },
      { type: 'assistant', id: 'a2', turnId: 't', text: 'All 40 tests pass.', streaming: false },
      { type: 'assistant', id: 'a3', turnId: 't', text: 'Nothing else needed.', streaming: false }
    ]
  }, {
    provider: 'codex', model: null, status: 'interrupted', items: [
      { type: 'user', id: 'u', turnId: 't2', text: 'and lint' },
      { type: 'assistant', id: 'b1', turnId: 't2', text: 'Starting the linter.', streaming: false },
      { type: 'tool', id: 'y', turnId: 't2', kind: 'command', label: 'npm run lint', status: 'failed', output: '' }
    ]
  }])!
  assert.doesNotMatch(handoff.text, /Let me run the tests first/)
  assert.match(handoff.text, /All 40 tests pass\.\n\nNothing else needed\./)
  assert.match(handoff.text, /Starting the linter\./, 'a turn that ended on a call keeps its last words')
})

test('older turns keep their files and a shortened request and reply; the newest go whole', () => {
  const tool = (id: string, kind: 'edit' | 'command', label: string): Item => ({ type: 'tool', id, turnId: 't', kind, label, status: 'done', output: '' })
  const turns = Array.from({ length: 5 }, (_, i) => turn('codex', `request ${i} ${'r'.repeat(3_000)}`, `answer ${i} ${'a'.repeat(3_000)}`, [
    tool(`e${i}`, 'edit', `src/file${i}.ts`),
    tool(`c${i}`, 'command', `npm test ${i}`)
  ]))
  const text = buildHandoff(turns)!.text
  for (const i of [0, 1]) {
    assert.match(text, new RegExp(`- edited: src/file${i}\\.ts`))
    assert.doesNotMatch(text, new RegExp(`npm test ${i}`))
  }
  for (const i of [2, 3, 4]) {
    assert.match(text, new RegExp(`npm test ${i}`))
    assert.ok(text.includes(`answer ${i} ${'a'.repeat(3_000)}`), `turn ${i} is whole`)
  }
  assert.equal((text.match(/characters omitted/g) ?? []).length, 4, 'the two older turns lost the middle of their request and reply')
})

test('a history too long to fit even cut down keeps the newest turns and says how many were left out', () => {
  const turns = Array.from({ length: 1_000 }, (_, index) => turn('codex', `question ${index} ${'q'.repeat(2_000)}`, `answer ${index} ${'a'.repeat(3_000)}`))
  const started = performance.now()
  const handoff = buildHandoff(turns)!
  assert.ok(performance.now() - started < 1_000, 'a thousand turns are handed over in well under a second')
  assert.ok(handoff.text.length < 31_000, `handoff was ${handoff.text.length} characters`)
  assert.match(handoff.text, /answer 999 /)
  assert.match(handoff.text, /The \d+ turns before these are left out/)
  assert.equal(handoff.turns, handoff.messages.filter((message) => message.role === 'user').length)
})
