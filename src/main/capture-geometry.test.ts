import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureName, selectionToPixels } from './capture-geometry.ts'

test('a selection in display coordinates maps to image pixels at any device scale, clamped', () => {
  assert.deepEqual(selectionToPixels({ x: 10, y: 20, width: 100, height: 50 }, { width: 1280, height: 720 }, { width: 2560, height: 1440 }), { x: 20, y: 40, width: 200, height: 100 })
  assert.deepEqual(selectionToPixels({ x: 10, y: 20, width: 100, height: 50 }, { width: 2560, height: 1080 }, { width: 2560, height: 1080 }), { x: 10, y: 20, width: 100, height: 50 })
  assert.deepEqual(selectionToPixels({ x: 2500, y: 1000, width: 400, height: 400 }, { width: 2560, height: 1080 }, { width: 2560, height: 1080 }), { x: 2500, y: 1000, width: 60, height: 80 })
  assert.deepEqual(selectionToPixels({ x: -5, y: -5, width: 0, height: 0 }, { width: 100, height: 100 }, { width: 100, height: 100 }), { x: 0, y: 0, width: 1, height: 1 })
})

test('capture names carry the source and time and are safe file names', () => {
  const at = new Date(2026, 9, 6, 7, 42, 5)
  assert.equal(captureName('app.northstar.io', at), 'app.northstar.io 2026-10-06 07.42.05.png')
  assert.equal(captureName('Terminal — npm run dev: /home/dp', at), 'Terminal — npm run dev home dp 2026-10-06 07.42.05.png')
  assert.equal(captureName('  ', at), 'Capture 2026-10-06 07.42.05.png')
})
