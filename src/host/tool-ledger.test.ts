import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ToolLedger, safeEvidence, normalizedError } from './tool-ledger.ts'
import { loadToolLedgerPanel, setToolLedgerReview } from './tool-ledger-panel.ts'
import { failureResult, ToolRegistry, type Tool } from './tools/registry.ts'
import { toolHistoryTools } from './tools/tool-history.ts'
import { toolReviewTools } from './tools/tool-review.ts'

const context = { provider: 'codex' as const, chatId: 'chat-1' }
const tool: Tool = { name: 'probe', description: 'Probe a fixture.', inputSchema: { type: 'object' }, run: () => ({ content: [] }) }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rocket-ledger-'))
  const path = join(dir, 'calls.db')
  let at = 1000
  const open = () => new ToolLedger(path, 'build-1', () => ({ model: 'test-model', turnId: 'turn-1' }), () => at)
  const ledger = open()
  return { dir, path, ledger, open, advance: (ms: number) => { at += ms }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('ledger records failures and successes, immutable finishes, versions and denominator-safe grouping', async () => {
  const f = fixture()
  try {
    const registry = new ToolRegistry(undefined, f.ledger)
    registry.add({ ...tool, run: args => args.fail ? failureResult('AMBIGUOUS_TARGET', 'Two matching targets.', 'operation') : { content: [{ type: 'text', text: JSON.stringify({ directory: '/capture', images: [{ path: '/capture/window.png' }] }) }] } })
    await Promise.all([registry.call('probe', { fail: true, password: 'private' }, context), registry.call('probe', {}, context)])
    const summary = f.ledger.summary({ code: 'AMBIGUOUS_TARGET' }) as any
    assert.equal(summary.groups[0].count, 1)
    assert.equal(summary.groups[0].successes, 1)
    assert.equal(summary.groups[0].failureRate, 0.5)
    const calls = f.ledger.query() as any
    const failed = calls.calls.find((row: any) => row.outcome === 'failure')
    const detail = (f.ledger.query({ callId: failed.id }) as any).calls[0]
    assert.equal(detail.arguments.password, '[REDACTED]')
    assert.equal(detail.model, 'test-model')
    assert.equal(detail.turnId, 'turn-1')
    f.ledger.finish(failed.id, { content: [] })
    assert.equal((f.ledger.query({ callId: failed.id }) as any).calls[0].outcome, 'failure')
    assert.deepEqual(calls.calls.find((row: any) => row.outcome === 'success').finish.artifacts, ['/capture', '/capture/window.png'])
    const newId = f.ledger.start('probe', { ...tool, version: 2 }, {}, context)
    f.ledger.finish(newId, failureResult('AMBIGUOUS_TARGET', 'Two matching targets.', 'operation'))
    assert.equal((f.ledger.summary() as any).groups.length, 2)
    assert.equal(statSync(f.path).mode & 0o777, 0o600)
  } finally { f.ledger.close(); f.cleanup() }
})

test('restart distinguishes interrupted calls, malformed evidence is skipped and retention preserves active calls', () => {
  const f = fixture()
  let reopened: ToolLedger | undefined
  try {
    const id = f.ledger.start('probe', tool, {}, context)
    assert.equal((f.ledger.query() as any).calls[0].outcome, 'running')
    f.ledger.close()
    reopened = f.open()
    assert.equal((reopened.query({ callId: id }) as any).calls[0].outcome, 'interrupted')
    const db = new DatabaseSync(f.path)
    db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?)').run('bad', 1000, 'old-instance', '{torn')
    db.close()
    assert.equal((reopened.query() as any).matching, 1)
    f.advance(31 * 86_400_000)
    const active = reopened.start('probe', tool, {}, context)
    reopened.prune()
    assert.equal((reopened.query({ callId: id }) as any).matching, 0)
    assert.equal((reopened.query({ callId: active }) as any).calls[0].outcome, 'running')
  } finally { reopened?.close(); f.cleanup() }
})

test('redacted evidence is bounded and fallback grouping removes volatile paths and numeric values', () => {
  const evidence = safeEvidence({ authorization: 'private', code: 'fetch("https://example.org/?token=private"); const apiKey = "hidden words"; Bearer opaque', items: Array.from({ length: 100 }, () => 'x'.repeat(10_000)) })
  const encoded = JSON.stringify(evidence)
  assert.equal(encoded.includes('private'), false)
  assert.equal(encoded.includes('hidden'), false)
  assert.equal(encoded.includes('words'), false)
  assert.equal(encoded.includes('opaque'), false)
  assert.ok(Buffer.byteLength(encoded) <= 16_000)
  assert.equal(normalizedError('Failed /tmp/session-one at 4000'), normalizedError('Failed /tmp/session-two at 5000'))
})

test('broken recording and diagnostics do not change tool behavior', async () => {
  const registry = new ToolRegistry(() => { throw new Error('diagnostic failure') }, {
    start: () => { throw new Error('disk full') }, finish: () => { throw new Error('write failure') }
  })
  registry.add(tool, { ...tool, name: 'throws', run: () => { throw new Error('Original exception') } })
  assert.deepEqual(await registry.call('probe', {}, context), { content: [] })
  const failed = await registry.call('throws', {}, context)
  assert.equal(failed.structuredContent?.error?.code, 'TOOL_EXCEPTION')
  assert.equal(failed.content[0].type === 'text' && failed.content[0].text, 'Original exception')
  assert.equal((await registry.call('missing', {}, context)).structuredContent?.error?.code, 'UNKNOWN_TOOL')
})

test('query tool validates filters and bounds JSON responses without returning arguments in lists', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 30; i++) {
      f.advance(1)
      const id = f.ledger.start('probe', tool, { code: 'x'.repeat(9000) }, context)
      f.ledger.finish(id, failureResult('UNCLASSIFIED', `failure ${i}: ${'text '.repeat(1000)}`, 'tool'))
    }
    const query = toolHistoryTools(f.ledger)[0]
    assert.equal((await query.run({ limit: Infinity }, context)).isError, true)
    const response = await query.run({ mode: 'calls', since: 0, limit: 50 }, context)
    assert.equal(response.content[0].type, 'text')
    if (response.content[0].type !== 'text') return
    assert.ok(Buffer.byteLength(response.content[0].text) <= 12_000)
    const data = JSON.parse(response.content[0].text)
    assert.equal(data.truncated, true)
    assert.equal(data.calls[0].arguments, undefined)
  } finally { f.ledger.close(); f.cleanup() }
})

test('concurrent tool calls record distinct finishes without cross-talk', async () => {
  const f = fixture()
  try {
    const registry = new ToolRegistry(undefined, f.ledger)
    registry.add({ ...tool, run: args => args.delay ? new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'slow' }] }), 5)) : { content: [{ type: 'text', text: String(args.tag) }] } })
    await Promise.all([
      registry.call('probe', { tag: 'a' }, context),
      registry.call('probe', { tag: 'b', delay: true }, context),
      registry.call('probe', { tag: 'c' }, context)
    ])
    const calls = (f.ledger.query({ since: 0, limit: 10 }) as any).calls.filter((row: any) => row.outcome === 'success')
    assert.equal(calls.length, 3)
    assert.equal(new Set(calls.map((row: any) => row.id)).size, 3)
  } finally { f.ledger.close(); f.cleanup() }
})

test('summary exposes context limits and description bytes beside success rates', () => {
  const f = fixture()
  try {
    const id = f.ledger.start('probe', { ...tool, description: 'x'.repeat(500) }, {}, context)
    f.ledger.finish(id, { content: [{ type: 'text', text: 'ok' }] })
    const summary = f.ledger.summary() as any
    assert.equal(summary.contextPolicy.historyInPrompts, false)
    assert.equal(summary.contextPolicy.maxQueryResponseBytes, 12_000)
    assert.equal(summary.scopes[0].descriptionBytes, 500)
    assert.equal(summary.scopes[0].successRate, 1)
  } finally { f.ledger.close(); f.cleanup() }
})

test('review annotations stay separate, support retry links and a bounded queue', async () => {
  const f = fixture()
  try {
    const failId = f.ledger.start('probe', tool, { pane: 'top-right' }, context)
    f.ledger.finish(failId, failureResult('AMBIGUOUS_TARGET', 'Two matching targets.', 'operation'))
    const okId = f.ledger.start('probe', tool, {}, context)
    f.ledger.finish(okId, { content: [{ type: 'text', text: '{}' }] })
    const reviewTool = toolReviewTools(f.ledger)[0]
    const missing = await reviewTool.run({ action: 'get', callId: '00000000-0000-4000-8000-000000000000' }, context)
    assert.equal(missing.structuredContent?.error?.code, 'NOT_FOUND')
    const annotated = await reviewTool.run({ action: 'annotate', callId: failId, lifecycle: 'diagnosed', causeCode: 'AMBIGUOUS_TARGET', causeNote: 'Matched greeting text in another pane.', proposedFix: 'Select pane by tab label or pane id.' }, context)
    assert.equal(JSON.parse(String(annotated.content[0].type === 'text' && annotated.content[0].text)).review.lifecycle, 'diagnosed')
    const linked = await reviewTool.run({ action: 'link_retry', callId: failId, retryCallId: okId }, context)
    assert.equal(JSON.parse(String(linked.content[0].type === 'text' && linked.content[0].text)).review.retryCallId, okId)
    const detail = (f.ledger.query({ callId: failId, since: 0 }) as any).calls[0]
    assert.equal(detail.review.lifecycle, 'diagnosed')
    assert.equal(detail.finish.error.code, 'AMBIGUOUS_TARGET')
    const queueResponse = await reviewTool.run({ action: 'queue', since: 0 }, context)
    const queue = JSON.parse(String(queueResponse.content[0].type === 'text' && queueResponse.content[0].text))
    assert.equal(queue.queue.some((row: any) => row.callId === failId), true)
    await reviewTool.run({ action: 'annotate', callId: failId, lifecycle: 'verified' }, context)
    const clearedResponse = await reviewTool.run({ action: 'queue', since: 0 }, context)
    const cleared = JSON.parse(String(clearedResponse.content[0].type === 'text' && clearedResponse.content[0].text))
    assert.equal(cleared.queue.some((row: any) => row.callId === failId), false)
    f.advance(31 * 86_400_000)
    f.ledger.prune()
    assert.equal(f.ledger.review(failId), null)
  } finally { f.ledger.close(); f.cleanup() }
})

test('setToolLedgerReview rejects invalid lifecycle and annotates like MCP review', () => {
  const f = fixture()
  try {
    const failId = f.ledger.start('probe', tool, {}, context)
    f.ledger.finish(failId, failureResult('AMBIGUOUS_TARGET', 'Two targets.', 'operation'))
    assert.throws(() => setToolLedgerReview(f.ledger, { callId: failId, lifecycle: 'bogus' as any }), /Unsupported lifecycle/)
    const review = setToolLedgerReview(f.ledger, { callId: failId, lifecycle: 'diagnosed', causeCode: 'AMBIGUOUS_TARGET' })
    assert.equal(review.lifecycle, 'diagnosed')
    assert.equal(f.ledger.review(failId)?.lifecycle, 'diagnosed')
  } finally { f.ledger.close(); f.cleanup() }
})

test('panel loader exposes registered tools and summary fields for the Tools panel', () => {
  const f = fixture()
  try {
    const registry = new ToolRegistry(undefined, f.ledger)
    registry.add(tool)
    const id = f.ledger.start('probe', tool, {}, context)
    f.ledger.finish(id, failureResult('AMBIGUOUS_TARGET', 'Two targets.', 'operation'))
    const panel = loadToolLedgerPanel(f.ledger, registry.list())
    assert.equal(panel.available, true)
    assert.equal(panel.registeredTools?.some(row => row.name === 'probe'), true)
    assert.equal(panel.contextPolicy?.historyInPrompts, false)
    assert.equal((panel.groups?.length ?? 0) >= 1, true)
  } finally { f.ledger.close(); f.cleanup() }
})

test('opening an unavailable ledger can be handled without corrupting an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rocket-ledger-invalid-'))
  try {
    const file = join(dir, 'not-a-directory')
    writeFileSync(file, 'keep')
    assert.throws(() => new ToolLedger(join(file, 'calls.db'), 'build'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
