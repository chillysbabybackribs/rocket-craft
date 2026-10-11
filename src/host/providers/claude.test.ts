import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from '../../shared/types.ts'
import { TurnTranslator } from './claude.ts'

const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event })
const restated = (text: string) => ({ type: 'assistant', uuid: 'u', message: { content: [{ type: 'text', text }] } })

/** One streamed text block, as the SDK sends it; the restatement lands before or after the stop. */
function say(translator: TurnTranslator, text: string, restateFirst: boolean): Item[] {
  const messages = [
    stream({ type: 'message_start' }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { text } }),
    ...(restateFirst
      ? [restated(text), stream({ type: 'content_block_stop', index: 0 })]
      : [stream({ type: 'content_block_stop', index: 0 }), restated(text)])
  ]
  return messages.flatMap((message) => translator.handle(message).ops).flatMap((op) => (op.type === 'item' ? [op.item] : []))
}

for (const restateFirst of [false, true]) {
  test(`the same text said twice in a turn is two closed rows (restated ${restateFirst ? 'before' : 'after'} the stop)`, () => {
    const translator = new TurnTranslator('t')
    const rows = [...say(translator, 'Done.', restateFirst), ...say(translator, 'Done.', restateFirst)]
    const closed = rows.filter((item) => item.type === 'assistant' && !item.streaming)
    assert.equal(new Set(rows.map((item) => item.id)).size, 2)
    assert.deepEqual(closed.map((item) => item.type === 'assistant' && item.text), ['Done.', 'Done.'])
    assert.equal(new Set(closed.map((item) => item.id)).size, 2)
  })
}

test('a reply that ends while background tasks run keeps its turn open for the follow-up', async () => {
  const { ClaudeAdapter } = await import('./claude.ts')
  const adapter = new ClaudeAdapter(() => {})
  const items: Item[] = []
  const results: unknown[] = []
  const activity: Array<string | null> = []
  // The adapter's runtime, reduced to what message routing touches; no Claude Code process runs.
  const runtime = {
    alive: true, background: new Set<string>(), woke: [] as string[], cwd: '/w', sessionId: 's', model: null,
    turn: null as unknown, disarmIdle() {}, armIdle() {}
  }
  runtime.turn = {
    request: { chatId: 'c', turnId: 't', cwd: '/w', sessionId: 's', model: null, text: '', handoff: null },
    sink: { item: (item: Item) => items.push(item), delta() {}, session() {}, model() {}, usage() {}, activity: (text: string | null) => activity.push(text) },
    translator: new TurnTranslator('t'),
    finish: (result: unknown) => { results.push(result); runtime.turn = null }
  }
  const route = (message: Record<string, unknown>): void => (adapter as unknown as { onMessage: (r: unknown, m: unknown) => void }).onMessage(runtime, message)
  const reply = (text: string): void => {
    route(stream({ type: 'message_start' }))
    route(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
    route(stream({ type: 'content_block_delta', index: 0, delta: { text } }))
    route(stream({ type: 'content_block_stop', index: 0 }))
    route({ type: 'result', subtype: 'success' })
  }

  route({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'research' }] })
  reply('Started the research.')
  assert.equal(results.length, 0, 'the turn stays open while the task runs')
  assert.equal(activity.at(-1), 'Waiting for 1 background task')
  assert.ok(!items.some((item) => item.type === 'notice'), 'the wait is not written into the reply')

  route({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'research done', output_file: '' })
  route({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  reply('Here is what it found.')
  assert.deepEqual(results, [{ status: 'completed' }], 'the follow-up lands in the same turn and ends it')
  assert.equal(activity.at(-1), null, 'the follow-up goes back to thinking')
  assert.ok(items.some((item) => item.type === 'assistant' && item.text === 'Here is what it found.'))
})

test('TodoWrite is the turn\'s plan, replaced whole on each update and never a tool row', () => {
  const translator = new TurnTranslator('t')
  const todos = (list: Array<[string, string]>) => ({ todos: list.map(([content, status]) => ({ content, status, activeForm: content })) })
  const call = (id: string, input: Record<string, unknown>) => [
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'TodoWrite', input: {} } }),
    stream({ type: 'content_block_delta', index: 0, delta: { partial_json: JSON.stringify(input) } }),
    stream({ type: 'content_block_stop', index: 0 }),
    { type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name: 'TodoWrite', input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }] } }
  ]
  const first = todos([['Read the API', 'in_progress'], ['Add login', 'pending']])
  const second = todos([['Read the API', 'completed'], ['Add login', 'in_progress']])
  const items = [...call('w1', first), ...call('w2', second), ...call('w3', second)]
    .flatMap((message) => translator.handle(message).ops).flatMap((op) => (op.type === 'item' ? [op.item] : []))
  assert.deepEqual(items.map((item) => item.type), ['plan', 'plan'])
  assert.deepEqual(items.map((item) => item.id), ['t:plan', 't:plan'])
  assert.deepEqual(items[1], {
    type: 'plan', id: 't:plan', turnId: 't',
    steps: [{ text: 'Read the API', status: 'done' }, { text: 'Add login', status: 'doing' }]
  })
})

test("a turn's tokens add up its results, and its context is the last model call's input", () => {
  const translator = new TurnTranslator('t')
  translator.handle({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-x' })
  const start = (input: number) => stream({ type: 'message_start', message: { usage: { input_tokens: input, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 100 } } })
  translator.handle(start(10))
  translator.handle(start(50))
  const modelUsage = { 'claude-x': { contextWindow: 200_000 }, 'claude-haiku': { contextWindow: 100_000 } }
  const usage = { input_tokens: 60, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 200, output_tokens: 700 }
  const first = translator.handle({ type: 'result', subtype: 'success', usage, modelUsage })
  assert.deepEqual(first.tokens, { input: 18_260, cached: 18_000, output: 700, context: 9_150, contextWindow: 200_000 })
  assert.equal(first.end?.status, 'completed')
  // The follow-up after background work is the same turn, so its result adds to it.
  translator.handle(start(5))
  const second = translator.handle({ type: 'result', subtype: 'success', usage: { ...usage, output_tokens: 300 }, modelUsage })
  assert.deepEqual(second.tokens, { input: 36_520, cached: 36_000, output: 1_000, context: 9_105, contextWindow: 200_000 })
  assert.equal(translator.handle({ type: 'result', subtype: 'success' }).tokens, undefined, 'a result without usage gives no reading')
})
