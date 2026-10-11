import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexTokens, CodexAdapter } from './codex.ts'
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
