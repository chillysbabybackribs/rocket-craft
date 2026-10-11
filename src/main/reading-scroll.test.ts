import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readingOf } from './reading-scroll.ts'

test("the page's reading status is kept only while it reads, and rounded for the toolbar", () => {
  assert.deepEqual(readingOf({ state: 'running', progress: 0.12345, secondsLeft: 31.6 }), { state: 'running', progress: 0.123, secondsLeft: 32 })
  assert.deepEqual(readingOf({ state: 'end', progress: 1.4, secondsLeft: -3 }), { state: 'end', progress: 1, secondsLeft: 0 })
  assert.deepEqual(readingOf({ state: 'paused', progress: 'x', secondsLeft: Number.NaN }), { state: 'paused', progress: 0, secondsLeft: 0 })
  assert.equal(readingOf({ state: 'off', progress: 0, secondsLeft: 0 }), null)
  assert.equal(readingOf(undefined), null)
  assert.equal(readingOf('running'), null)
})
