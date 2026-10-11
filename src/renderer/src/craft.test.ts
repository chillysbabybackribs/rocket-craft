import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHELF_ORDER, shelfOrder, sizeText } from './craft.ts'

test('the shelf puts the creative apps first and unknown apps last, in catalog order', () => {
  const catalog = ['newcraft', 'gridcraft', 'photocraft', 'othercraft', 'cadcraft', 'soundcraft'].map((id) => ({ id }))
  assert.deepEqual(shelfOrder(catalog).map((app) => app.id), ['photocraft', 'soundcraft', 'gridcraft', 'cadcraft', 'newcraft', 'othercraft'])
  assert.equal(SHELF_ORDER.length, 12)
})

test('sizes read as the shelf shows them', () => {
  assert.equal(sizeText(72_000_000), '72 MB')
  assert.equal(sizeText(1_250_000_000), '1.3 GB')
  assert.equal(sizeText(0), '—')
})
