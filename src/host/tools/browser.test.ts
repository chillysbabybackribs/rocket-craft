import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import type { AgentTab, BrowserAgentOp, BrowserDownload } from '../../shared/types.ts'
import { browserContext, browserTools, describeDownload, savePath, BROWSER_RESEARCH_GUIDE } from './browser.ts'

test('closing tabs never marks, loads or inspects a page as a side effect', async () => {
  const asked: BrowserAgentOp[] = []
  const run = browserTools({ request: async op => {
    asked.push(op)
    if (op.op === 'tabs') return [{ id: 't1' }, { id: 't2' }]
    if (op.op === 'close') return null
    throw new Error(`Unexpected page operation: ${op.op}`)
  } }, '/tmp/unused').find(tool => tool.name === 'browser_run')!
  const result = await run.run({ code: 'for (const t of await browser.tabs()) await browser.tab(t.id).close(); return await browser.tabs()' }, { provider: 'codex', chatId: 'close-test' })
  assert.equal(result.isError, false)
  assert.deepEqual(asked.map(op => op.op), ['tabs', 'close', 'close', 'tabs'])
})

const sampleTabs: AgentTab[] = [{
  id: 't1', url: 'https://example.com/doc', title: 'Doc', active: true, loading: false, agent: true
}]

test('browser context names the open tabs to a new session, then only when they change', async () => {
  let tabs = sampleTabs
  const context = browserContext({ request: async () => tabs })
  const first = await context('chat-1', 'codex', true)
  assert.match(first!, /<browser>[\s\S]*example\.com/)
  assert.equal(await context('chat-1', 'codex', false), null)
  assert.match((await context('chat-1', 'claude', true))!, /example\.com/, 'each provider session is told for itself')
  tabs = [...sampleTabs, { ...sampleTabs[0]!, id: 't2', url: 'https://example.org/', active: false }]
  assert.match((await context('chat-1', 'codex', false))!, /example\.org/)
})

test('browser context says nothing with no tabs open, and research guidance rides in the tool description only', async () => {
  const context = browserContext({ request: async () => [] as AgentTab[] })
  assert.equal(await context('chat-2', 'codex', true), null)
  const read = browserTools({ request: async () => null }, '/tmp/unused').find((tool) => tool.name === 'browser_read')!
  assert.ok(read.description.includes(BROWSER_RESEARCH_GUIDE))
})

test('browser_download sends main an absolute saveTo, and reports where the file went', async () => {
  const asked: BrowserAgentOp[] = []
  const done: BrowserDownload = { id: 'd1', chat: 'chat-1', url: 'https://example.com/a.pdf', name: 'a.pdf', path: '/work/files/a.pdf', mime: 'application/pdf', size: 2048, received: 2048, state: 'completed', startedAt: 1 }
  const download = browserTools({ request: async (op) => { asked.push(op); return done } }, '/tmp/unused', () => '/work').find((tool) => tool.name === 'browser_download')!
  const result = await download.run({ url: 'https://example.com/a.pdf', saveTo: 'files/' }, { provider: 'claude', chatId: 'chat-1' })
  assert.deepEqual(asked[0], { op: 'download', chat: 'chat-1', tab: null, url: 'https://example.com/a.pdf', target: null, saveTo: '/work/files/', timeout: 120_000 })
  assert.equal(result.isError, false)
  assert.match(result.content[0]!.type === 'text' ? result.content[0]!.text : '', /Downloaded a\.pdf \(2\.0 KB, application\/pdf\) to \/work\/files\/a\.pdf/)
  const neither = await download.run({}, { provider: 'claude', chatId: 'chat-1' })
  assert.equal(neither.isError, true)
  const both = await download.run({ url: 'x', click: 'e1' }, { provider: 'claude', chatId: 'chat-1' })
  assert.equal(both.isError, true)
  assert.equal(asked.length, 1, 'a call with neither or both is refused before main is asked')
})

test('saveTo paths resolve from the chat folder or home, and downloads in flight say so', () => {
  assert.equal(savePath('', '/work'), null)
  assert.equal(savePath('/abs/file.zip', '/work'), '/abs/file.zip')
  assert.equal(savePath('~/Desktop/', '/work'), `${homedir()}/Desktop/`)
  assert.equal(savePath('out/report.pdf', '/work'), '/work/out/report.pdf')
  assert.equal(savePath('out', null), `${homedir()}/out`)
  const base: BrowserDownload = { id: 'd2', chat: 'c', url: 'https://example.com/big.iso', name: 'big.iso', path: '/d/big.iso', mime: '', size: 4 * 1024 * 1024, received: 1024 * 1024, state: 'progressing', startedAt: 1 }
  assert.match(describeDownload(base, 120), /Still downloading after 120s: 1\.0 MB so far \(25% of 4\.0 MB\)\. It will be at \/d\/big\.iso/)
  assert.match(describeDownload({ ...base, state: 'interrupted' }, 5), /was interrupted/)
})

test('the pages a chat asks the browser for are reported with the chat, and a read of the tab as it is reports nothing', async () => {
  const opened: Array<[string | null, string]> = []
  const tools = browserTools({ request: async () => 'page text' }, '/tmp/unused', () => null, (chatId, url) => opened.push([chatId, url]))
  const read = tools.find((tool) => tool.name === 'browser_read')!
  const context = { provider: 'claude' as const, chatId: 'chat-1' }
  await read.run({ url: 'https://example.com/docs' }, context)
  await read.run({ tab: 't2' }, context)
  assert.deepEqual(opened, [['chat-1', 'https://example.com/docs']])
})

test('browser challenge and rejected navigation never earn evidence; tab-only reads do', async () => {
  const opened: string[] = []
  let body = '# Just a moment...\nhttps://example.com/ · tab t2'
  const tools = browserTools({ request: async () => body }, '/tmp/unused', () => null, (_, url) => opened.push(url))
  const read = tools.find(t => t.name === 'browser_read')!
  const context = { provider: 'codex' as const, chatId: 'challenge-test' }
  assert.equal((await read.run({ url: 'https://example.com' }, context)).isError, true)
  assert.deepEqual(opened, [])
  body = '# Research\nhash: (no hash)\nhttps://example.com/article · tab t2\n\nActual source text.'
  assert.ok(!(await read.run({ tab: 't2' }, context)).isError)
  assert.deepEqual(opened, ['https://example.com/article'])
})

test('network-only and controls-only inspections do not count as reading source content', async () => {
  const opened: string[] = []
  const read = browserTools({ request: async () => '# Page\nhttps://example.org/ · tab t2\nRequests and controls' }, '/tmp/unused', () => null, (_, url) => opened.push(url)).find(t => t.name === 'browser_read')!
  for (const focus of ['network', 'elements']) await read.run({ url: 'https://example.org/', focus }, { provider: 'cursor', chatId: 'c' })
  assert.deepEqual(opened, [])
})
