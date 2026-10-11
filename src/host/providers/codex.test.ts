import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexItem, codexTokens, CodexAdapter, imageLimitText } from './codex.ts'
import type { TurnSink } from './provider.ts'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

for (const idSource of ['reply', 'notification']) {
  test(`early Stop waits for the Codex turn ID from its ${idSource} and interrupts remotely once`, async () => {
    const adapter = new CodexAdapter(() => {})
    const calls: Array<{ method: string; params: unknown }> = []
    let started!: (reply: unknown) => void
    const internals = adapter as unknown as {
      client: unknown
      onNotification(notification: unknown): void
    }
    internals.client = {
      connected: true,
      request: async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'thread' } }
        if (method === 'turn/start') return new Promise((resolve) => { started = resolve })
        return {}
      }
    }
    const sink: TurnSink = { session() {}, model() {}, item() {}, delta() {}, usage() {}, tokens() {}, activity() {} }
    let settled = false
    const running = adapter.run({ chatId: 'chat', turnId: 'local', cwd: '/work', sessionId: null, model: null, text: 'hello', handoff: null }, sink)
    void running.then(() => { settled = true })
    await tick()
    await adapter.stop('chat')
    assert.equal(settled, false, 'must not discard a remotely starting turn')
    if (idSource === 'notification') {
      internals.onNotification({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'remote' } } })
    }
    started({ turn: { id: 'remote' } })
    await tick()
    await adapter.stop('chat')
    assert.deepEqual(calls.filter((call) => call.method === 'turn/interrupt'), [
      { method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'remote' } }
    ])
    assert.equal(settled, false, 'wait for remote completion after interrupt acknowledgement')
    internals.onNotification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'remote', status: 'interrupted' } } })
    assert.deepEqual(await running, { status: 'interrupted' })
  })
}

test("a turn's tokens are the thread's running count less where it stood before the turn", () => {
  const usage = (total: [number, number, number], last: [number, number, number]) => ({
    total: { inputTokens: total[0], cachedInputTokens: total[1], outputTokens: total[2], reasoningOutputTokens: 0, totalTokens: 0 },
    last: { inputTokens: last[0], cachedInputTokens: last[1], outputTokens: last[2], reasoningOutputTokens: 0, totalTokens: 0 },
    modelContextWindow: 272_000
  })
  // The thread already held 100k input from earlier turns; this turn's first call read 30k.
  const first = codexTokens(usage([130_000, 90_000, 2_000], [30_000, 25_000, 500]), null)!
  assert.deepEqual(first.tokens, { input: 30_000, cached: 25_000, output: 500, context: 30_000, contextWindow: 272_000 })
  const second = codexTokens(usage([162_000, 120_000, 2_800], [32_000, 30_000, 800]), first.base)!
  assert.deepEqual(second.tokens, { input: 62_000, cached: 55_000, output: 1_300, context: 32_000, contextWindow: 272_000 })
  assert.equal(codexTokens({}, null), null)
})

// The thread item shapes from `codex app-server generate-ts` (codex-cli 0.161.0), with the
// values Codex's rollout files show for real generations.
const generation = (fields: Record<string, unknown>) => ({
  type: 'imageGeneration', id: 'ig_1', status: 'in_progress', revisedPrompt: 'A neon horizon over a desert city', result: '', failure: null, ...fields
})

test('an image being made is a placeholder with its caption', () => {
  assert.deepEqual(codexItem(generation({ revisedPrompt: null }), 't', false), {
    type: 'image', id: 't:ig_1', turnId: 't', status: 'generating', caption: ''
  })
})

test('a finished image carries the file Codex saved and its bytes for the hub to keep', () => {
  const savedPath = '/home/me/.codex/generated_images/thread/ig_1.png'
  assert.deepEqual(codexItem(generation({ status: 'completed', result: 'iVBORw0KGgo=', savedPath }), 't', true), {
    type: 'image', id: 't:ig_1', turnId: 't', status: 'done', caption: 'A neon horizon over a desert city',
    source: { path: savedPath, base64: 'iVBORw0KGgo=' }
  })
})

test('a finished image with only its base64 result still has something to keep', () => {
  const item = codexItem(generation({ status: 'completed', result: 'iVBORw0KGgo=' }), 't', true)
  assert.equal(item?.type === 'image' && item.status, 'done')
  assert.deepEqual(item?.type === 'image' && item.source, { base64: 'iVBORw0KGgo=' })
})

test('a finished image with nothing to keep is a failure that says so', () => {
  const item = codexItem(generation({ status: 'completed' }), 't', true)
  assert.equal(item?.type === 'image' && item.status, 'failed')
  assert.match(item?.type === 'image' ? item.error ?? '' : '', /did not send it\. Ask for it again\./)
})

test('a usage-limit failure says what happened and when to try again', () => {
  const resetsAt = Math.floor(new Date(2026, 9, 11, 15, 40).getTime() / 1000)
  const item = codexItem(generation({ status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt } }), 't', true)
  assert.equal(item?.type === 'image' && item.status, 'failed')
  const error = item?.type === 'image' ? item.error ?? '' : ''
  assert.match(error, /^Codex has used up its image generation limit for now\. Try again after .*3:40.*\.$/)
  assert.ok(!('source' in (item ?? {})))
  assert.match(imageLimitText(null), /did not say when it resets; try again later\.$/)
  assert.doesNotMatch(imageLimitText(resetsAt, new Date(2026, 9, 11, 9).getTime()), /Oct/, 'the same day gives only the time')
})

test('a failure without a reason, as seen in a rollout, is still a sentence', () => {
  const item = codexItem(generation({ status: 'failed', transparentBackground: null }), 't', true)
  assert.deepEqual(item, { type: 'image', id: 't:ig_1', turnId: 't', status: 'failed', caption: 'A neon horizon over a desert city',
    error: 'Codex could not make this image. Ask again, or reword the request if it may have been refused.' })
})

test('Codex viewing an image is a small step naming the file', () => {
  assert.deepEqual(codexItem({ type: 'imageView', id: 'v1', path: 'file:///tmp/kit/prompt-kit.png' }, 't', true), {
    type: 'tool', id: 't:v1', turnId: 't', kind: 'other', status: 'done', label: 'Viewed prompt-kit.png', output: '/tmp/kit/prompt-kit.png'
  })
})
