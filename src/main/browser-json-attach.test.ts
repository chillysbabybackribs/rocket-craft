import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAttachedJson, truncateJsonBody } from './browser-json-attach.ts'

test('truncateJsonBody keeps short JSON whole', () => {
  assert.equal(truncateJsonBody('{"a":1}'), '{"a":1}')
})

test('truncateJsonBody clips long JSON', () => {
  const long = '{"x":"' + 'y'.repeat(5000) + '"}'
  const out = truncateJsonBody(long, 100)
  assert.match(out, /more characters/)
  assert.ok(out.length < long.length)
})

test('formatAttachedJson wraps with request id', () => {
  assert.match(formatAttachedJson('r9', '{"ok":true}'), /r9/)
  assert.match(formatAttachedJson('r9', '{"ok":true}'), /```json/)
})
