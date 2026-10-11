import assert from 'node:assert/strict'
import test from 'node:test'
import { addedBucket, filterEntries, kindOf, parseFilters, type LibraryEntry } from './library.ts'

const entry = (patch: Partial<LibraryEntry>): LibraryEntry => ({
  id: 'f1', name: 'file.txt', kind: 'text', source: 'opened', origin: 'docs', chatId: null, path: '/w/docs/file.txt', size: 10, addedAt: 0, missing: false, ...patch
})

test('a file’s kind comes from its name', () => {
  assert.equal(kindOf('Report.PDF'), 'pdf')
  assert.equal(kindOf('plan.md'), 'markdown')
  assert.equal(kindOf('shot.jpeg'), 'image')
  assert.equal(kindOf('deck.pptx'), 'office')
  assert.equal(kindOf('main.ts'), 'text')
  assert.equal(kindOf('archive.tar.gz'), 'other')
})

test('added buckets follow the local calendar', () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime()
  assert.equal(addedBucket(new Date(2026, 9, 6, 0, 1).getTime(), now), 'today')
  assert.equal(addedBucket(new Date(2026, 9, 5, 23, 59).getTime(), now), 'yesterday')
  assert.equal(addedBucket(new Date(2026, 9, 1, 12).getTime(), now), 'week')
  assert.equal(addedBucket(new Date(2026, 8, 20).getTime(), now), 'older')
})

test('filters combine, and search needs every word somewhere in the name, origin, path or chat title', () => {
  const now = Date.now()
  const entries = [
    entry({ id: 'a', name: 'react.pdf', kind: 'pdf', source: 'download', origin: 'arxiv.org', chatId: 'c1', addedAt: now }),
    entry({ id: 'b', name: 'plan.md', kind: 'markdown', source: 'plan', origin: 'docs', chatId: 'c2', addedAt: now }),
    entry({ id: 'c', name: 'shot.png', kind: 'image', source: 'attachment', origin: 'attachment', chatId: 'c1', addedAt: 0 })
  ]
  const title = (id: string): string => (id === 'c1' ? 'Agent research' : 'Library design')
  assert.deepEqual(filterEntries(entries, { kind: 'pdf' }).map((each) => each.id), ['a'])
  assert.deepEqual(filterEntries(entries, { chat: 'c1', added: 'today' }, title).map((each) => each.id), ['a'])
  assert.deepEqual(filterEntries(entries, { q: 'agent png' }, title).map((each) => each.id), ['c'])
  assert.deepEqual(filterEntries(entries, { q: 'ARXIV' }, title).map((each) => each.id), ['a'])
  assert.deepEqual(filterEntries(entries, {}, title).length, 3)
})

test('loose filter input is checked, and an unknown value is refused with the valid ones', () => {
  assert.deepEqual(parseFilters({ kind: 'pdf', source: '', added: 'any', q: '  plan ', chat: 'c1' }), { kind: 'pdf', q: 'plan', chat: 'c1' })
  assert.throws(() => parseFilters({ kind: 'spreadsheet' }), /kind is one of pdf, markdown/)
})
