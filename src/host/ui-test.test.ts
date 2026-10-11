import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UiTestAdapter, uiTestProfile } from './ui-test.ts'
import type { TurnSink } from './providers/provider.ts'

test('UI mode requires an explicit marked profile and matching host data directory', () => {
  const profile = mkdtempSync(join(tmpdir(), 'rocket-ui-guard-'))
  try {
    assert.equal(uiTestProfile({}), null)
    assert.throws(() => uiTestProfile({ CRAFT_UI_TEST: '1' }), /isolated profile/)
    assert.throws(() => uiTestProfile({ CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile }), /isolated profile/)
    writeFileSync(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
    assert.equal(uiTestProfile({ CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile }), profile)
    assert.throws(() => uiTestProfile({ CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile, CRAFT_DATA_DIR: '/other' }), /isolated profile/)
  } finally { rmSync(profile, { recursive: true, force: true }) }
})

test('a controlled stream remains pending until stopped and emits no final response after stop', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'rocket-ui-stream-'))
  const adapter = new UiTestAdapter('codex', profile)
  const deltas: string[] = []
  const sink: TurnSink = { item: () => {}, delta: (_id, text) => deltas.push(text), session: () => {}, model: () => {}, usage: () => {}, tokens: () => {}, activity: () => {} }
  try {
    const result = adapter.run({ chatId: 'chat', turnId: 'turn', cwd: profile, sessionId: null, model: null, text: 'UI check: stop', handoff: null }, sink)
    assert.deepEqual(deltas, ['Streaming from codex.'])
    await adapter.stop('chat')
    assert.deepEqual(await result, { status: 'interrupted' })
    assert.deepEqual(deltas, ['Streaming from codex.'])
  } finally { adapter.shutdown(); rmSync(profile, { recursive: true, force: true }) }
})
