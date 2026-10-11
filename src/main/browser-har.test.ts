import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHar } from './browser-har.ts'

test('buildHar filters by request seq and shapes entries', () => {
  const har = buildHar([
    { id: 'r1', method: 'GET', url: 'https://example.com/a', kind: 'XHR', status: 200, mime: 'application/json', size: 120 },
    { id: 'r5', method: 'GET', url: 'https://example.com/b', kind: 'Fetch', status: 404, mime: 'text/html', size: 40 }
  ], 2)
  assert.equal(har.log.entries.length, 1)
  const entry = har.log.entries[0] as { request: { url: string }; rocket: { id: string } }
  assert.equal(entry.request.url, 'https://example.com/b')
  assert.equal(entry.rocket.id, 'r5')
})
