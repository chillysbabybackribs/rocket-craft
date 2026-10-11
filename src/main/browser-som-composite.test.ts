import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeXml, somSvg } from './browser-som-svg.ts'

test('somSvg places a badge label at scaled coordinates', () => {
  const svg = somSvg([{ ref: 'e12', left: 10, top: 20 }], 1280, 800, 2)
  assert.match(svg, /translate\(20,40\)/)
  assert.match(svg, />e12</)
  assert.match(svg, /fill="#dc2626"/)
})

test('escapeXml escapes markup in ref labels', () => {
  assert.equal(escapeXml('a&b'), 'a&amp;b')
})
