import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolChannel, SHARED } from './channel.ts'
import { ToolRegistry, textResult, WORKER_TOOL_REFUSAL, type ToolRole } from './registry.ts'

 test('saved profiles govern MCP lists and calls, including shared Antigravity identity', async () => {
  const roles: Record<string, ToolRole> = { leader: 'leader', worker: 'worker', ordinary: 'ordinary' }
  const executed: string[] = []
  const registry = new ToolRegistry(undefined, undefined, id => roles[id] ?? 'ordinary')
  const names = ['ask_user', 'orchestrator', 'studio_ui_go', 'studio_ui_where', 'studio_ui_run', 'studio_tool_history', 'studio_tool_review', 'studio_check', 'studio_diagnostics', 'studio_note', 'browser_read', 'browser_run', 'web_search', 'web_read', 'library_list', 'remember']
  for (const name of names) registry.add({ name, description: name, inputSchema: { type: 'object', properties: { target: { enum: ['live', 'isolated'] } } }, run: () => { executed.push(name); return textResult('Executed.') } })
  let active: string | null = 'worker'
  const channel = new ToolChannel(registry, null, () => active)
  await channel.start()
  try {
    const rpc = async (chat: string, method: string, params = {}, provider: 'codex' | 'antigravity' = 'codex') => {
      const response = await fetch(channel.url(provider, chat), { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return await response.json() as { result?: { tools: Array<{ name: string; inputSchema: { properties: { target: { enum: string[] } }; required: string[] } }>; isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } }
    }
    for (const [chat, expected] of Object.entries({ ordinary: names, leader: names.filter(name => name !== 'ask_user'), worker: ['studio_ui_run', 'browser_read', 'browser_run', 'web_search', 'web_read', 'library_list', 'remember'] })) {
      assert.deepEqual((await rpc(chat, 'tools/list')).result!.tools.map(tool => tool.name), expected)
    }
    const isolated = (await rpc('worker', 'tools/list')).result!.tools.find(tool => tool.name === 'studio_ui_run')!
    assert.deepEqual(isolated.inputSchema.properties.target.enum, ['isolated'])
    assert.ok(isolated.inputSchema.required.includes('target'))
    for (const name of ['ask_user', 'orchestrator', 'studio_ui_go', 'studio_ui_where', 'studio_tool_review', 'studio_check']) {
      const result = (await rpc('worker', 'tools/call', { name })).result!
      assert.equal(result.isError, true)
      assert.equal(result.content[0]!.text, WORKER_TOOL_REFUSAL)
    }
    for (const args of [{}, { target: 'live' }]) assert.equal((await rpc('worker', 'tools/call', { name: 'studio_ui_run', arguments: args })).result!.isError, true)
    assert.equal((await rpc('worker', 'tools/call', { name: 'studio_ui_run', arguments: { target: 'isolated' } })).result!.isError, undefined)
    assert.deepEqual(executed, ['studio_ui_run'])
    // Reopened turns keep the same saved chat identity; cached calls cannot bypass it.
    assert.equal((await rpc('worker', 'tools/call', { name: 'ask_user' })).result!.isError, true)
    assert.deepEqual((await rpc(SHARED, 'tools/list', {}, 'antigravity')).result!.tools.map(tool => tool.name), registry.list('worker').map(tool => tool.name))
    active = 'leader'
    assert.equal((await rpc(SHARED, 'tools/call', { name: 'ask_user' }, 'antigravity')).result!.isError, true)
    active = null
    for (const method of ['tools/list', 'tools/call']) assert.match((await rpc(SHARED, method, { name: 'remember' }, 'antigravity')).error!.message, /cannot identify one active chat/)
    channel.bind('warm-key', 'worker')
    assert.deepEqual((await rpc('warm-key', 'tools/list')).result!.tools.map(tool => tool.name), registry.list('worker').map(tool => tool.name))
  } finally { channel.stop() }
})
