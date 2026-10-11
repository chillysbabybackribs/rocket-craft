import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampSpeed, nudgeSpeed, READING_MAX, READING_MIN, READING_SLIDER_MAX, sliderToSpeed, snapSpeed, speedLabel, speedToSlider, timeLeftLabel
} from './reading.ts'

test('the slider spans the speeds on a log scale', () => {
  assert.equal(sliderToSpeed(0), READING_MIN)
  assert.equal(sliderToSpeed(READING_SLIDER_MAX), READING_MAX)
  // Each doubling takes the same travel.
  const half = speedToSlider(0.5) - speedToSlider(0.25)
  assert.ok(Math.abs(speedToSlider(8) - speedToSlider(4) - half) < 1e-9)
  for (const speed of [0.3, 1, 2.7, 6]) assert.ok(Math.abs(sliderToSpeed(speedToSlider(speed)) - speed) < 1e-9)
})

test('a drag lands on a round speed near it, and anywhere else between', () => {
  assert.equal(snapSpeed(speedToSlider(1) + 10), 1)
  assert.equal(snapSpeed(speedToSlider(2) - 15), 2)
  assert.equal(snapSpeed(speedToSlider(3)), 3)
  assert.equal(snapSpeed(speedToSlider(1.4)), 1.4)
})

test('speeds stay in range whatever arrives', () => {
  assert.equal(clampSpeed(100), READING_MAX)
  assert.equal(clampSpeed(0), READING_MIN)
  assert.equal(clampSpeed(Number.NaN), 1)
  assert.equal(nudgeSpeed(READING_MAX, 1), READING_MAX)
  assert.equal(nudgeSpeed(1, 1), 1.1)
  assert.equal(nudgeSpeed(1, -1), 0.91)
})

test('labels read as the control shows them', () => {
  assert.equal(speedLabel(0.25), '¼×')
  assert.equal(speedLabel(0.5), '½×')
  assert.equal(speedLabel(1), '1×')
  assert.equal(speedLabel(2.74), '2.7×')
  assert.equal(timeLeftLabel(0.4), 'Done')
  assert.equal(timeLeftLabel(31.2), '32 s left')
  assert.equal(timeLeftLabel(250), '4 min left')
})
