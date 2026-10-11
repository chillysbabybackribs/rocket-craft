import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitBlocks } from './markdown-blocks.ts'

const trimmed = (text: string): string[] => splitBlocks(text).map((block) => block.trim())

test('paragraphs and headings split at blank lines, and the pieces join back to the text', () => {
  const text = '# Title\n\nFirst paragraph\nstill first.\n\n\nSecond **paragraph**.\n\n> quote'
  assert.deepEqual(trimmed(text), ['# Title', 'First paragraph\nstill first.', 'Second **paragraph**.', '> quote'])
  assert.equal(splitBlocks(text).join('\n'), text)
})

test('a blank line inside a code fence is not a boundary', () => {
  const text = 'Before\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter'
  assert.deepEqual(trimmed(text), ['Before', '```ts\nconst a = 1\n\nconst b = 2\n```', 'After'])
  // A fence still open holds everything after it, and a shorter or labelled run does not close it.
  assert.deepEqual(trimmed('Intro\n\n````md\n```\n\ntext\n\n```js\n\nmore'), ['Intro', '````md\n```\n\ntext\n\n```js\n\nmore'])
})

test('a list stays with the paragraph before it, loose items and indented continuations included', () => {
  const text = 'Steps:\n\n1. one\n\n2. two\n\n   more of two\n\n- other\n\nDone.'
  assert.deepEqual(trimmed(text), ['Steps:\n\n1. one\n\n2. two\n\n   more of two\n\n- other', 'Done.'])
})

test('emphasis and rules at the start of a line are not mistaken for list items', () => {
  assert.deepEqual(trimmed('One\n\n**Two**\n\n---\n\n*three*'), ['One', '**Two**', '---', '*three*'])
})

test('text with link definitions is left whole', () => {
  const text = 'See [the docs][d].\n\nMore.\n\n[d]: https://example.com'
  assert.deepEqual(splitBlocks(text), [text])
})

test('a table and a short text are single blocks', () => {
  assert.deepEqual(splitBlocks('| a | b |\n|---|---|\n| 1 | 2 |'), ['| a | b |\n|---|---|\n| 1 | 2 |'])
  assert.deepEqual(splitBlocks('partial'), ['partial'])
  assert.deepEqual(splitBlocks(''), [''])
})
