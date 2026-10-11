import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRoot, uiRunResult, UiRunManager } from './ui-run.ts'

test('multiple verbose UI captures keep parseable metadata, image content and full-result paths', () => {
  const result = uiRunResult({
    id: 7, ok: true, value: { plan: true }, session: { open: true },
    captures: Array.from({ length: 3 }, () => ({
      metadata: { directory: '/capture', shell: { controls: Array.from({ length: 100 }, () => ({ name: 'Control'.repeat(20), bounds: { x: 0, y: 0, width: 100, height: 30 } })), panels: [{ name: 'Plan' }] } },
      content: [{ type: 'image', data: 'jpeg-bytes', mimeType: 'image/jpeg' }]
    }))
  }, '/session')
  const first = result.content[0]
  assert.equal(first.type, 'text')
  if (first.type !== 'text') return
  const metadata = JSON.parse(first.text)
  assert.deepEqual(metadata.value, { plan: true })
  assert.equal(metadata.fullResult, '/session/run-7.json')
  assert.equal(metadata.captures[0].shell.controlsSavedIn, '/capture/snapshot.json')
  assert.equal(result.content.filter(block => block.type === 'image').length, 3)
  assert.equal(first.text.includes('jpeg-bytes'), false)
})

test('invalid UI requests do not start a supervisor or require a source installation', async () => {
  const manager = new UiRunManager('/must/not/start')
  assert.equal((await manager.run({ code: 'return 1' }, null)).isError, true)
  assert.equal((await manager.run({}, 'chat')).isError, true)
  assert.equal((await manager.run({ code: 'return 1', timeout: Infinity }, 'chat')).isError, true)
  assert.equal((await manager.run({ close: true }, 'chat')).isError, undefined)
  await manager.shutdown()
  assert.equal((await manager.run({ code: 'return 1' }, 'chat')).isError, true)
})

test('an isolated session builds from the chat\'s repository when it has a UI runner, else from the host\'s root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rocket-uirun-'))
  try {
    const tree = join(dir, 'tree'), bare = join(dir, 'bare')
    mkdirSync(join(tree, 'scripts'), { recursive: true })
    mkdirSync(bare)
    writeFileSync(join(tree, 'scripts/ui-runner.mjs'), '')
    for (const folder of [tree, bare]) execFileSync('git', ['init', '-q'], { cwd: folder })
    assert.equal(await buildRoot(join(tree, 'scripts'), '/host'), realpathSync(tree))
    assert.equal(await buildRoot(bare, '/host'), '/host', 'no runner there')
    assert.equal(await buildRoot(dir, '/host'), '/host', 'not a repository')
    assert.equal(await buildRoot(null, '/host'), '/host')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
