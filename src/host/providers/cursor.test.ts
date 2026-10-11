import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cursorExtensionReply } from './cursor.ts'

const outcome = (method: string, params: Record<string, unknown> = {}) =>
  (cursorExtensionReply(method, params) as { outcome: Record<string, unknown> }).outcome

test('a blocking question is skipped and pointed at ask_user, so the turn never waits on a human', () => {
  const reply = outcome('cursor/ask_question', { toolCallId: 'c1', questions: [{ id: 'q1', prompt: 'Which?', options: [] }] })
  assert.equal(reply.outcome, 'skipped')
  assert.match(String(reply.reason), /ask_user/)
})

test('a plan asking for approval is accepted, as in an unattended session', () => {
  assert.deepEqual(outcome('cursor/create_plan', { toolCallId: 'c2', plan: '1. Do it', todos: [] }), { outcome: 'accepted' })
})

test('todos and task completions sent as requests are accepted with what they carried', () => {
  const todos = [{ id: '1', content: 'Write tests', status: 'pending' }]
  assert.deepEqual(outcome('cursor/update_todos', { toolCallId: 'c3', todos, merge: true }), { outcome: 'accepted', todos })
  assert.deepEqual(outcome('cursor/task', { toolCallId: 'c4', agentId: 'a1' }), { outcome: 'completed', agentId: 'a1' })
  assert.deepEqual(outcome('cursor/task', { toolCallId: 'c5' }), { outcome: 'completed' })
})

test('a method the app does not know is still refused', () => {
  assert.throws(() => cursorExtensionReply('cursor/generate_image', {}), /does not implement cursor\/generate_image/)
  assert.throws(() => cursorExtensionReply('toString', {}), /does not implement/)
})

test('the ACP plan update becomes the turn\'s plan item', async () => {
  const { UpdateTranslator } = await import('./cursor.ts')
  const translator = new UpdateTranslator('t')
  const ops = translator.handle({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Read the API', priority: 'high', status: 'completed' },
      { content: 'Add login', priority: 'high', status: 'in_progress' },
      { content: 'Write the test', priority: 'medium', status: 'pending' }
    ]
  })
  assert.deepEqual(ops, [{
    type: 'item',
    item: { type: 'plan', id: 't:plan', turnId: 't', steps: [
      { text: 'Read the API', status: 'done' }, { text: 'Add login', status: 'doing' }, { text: 'Write the test', status: 'todo' }
    ] }
  }])
  assert.deepEqual(translator.handle({ sessionUpdate: 'plan', entries: [] }), [])
})
