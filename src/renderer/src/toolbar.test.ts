import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessibleName, arrange, DEFAULT_TOOLBAR, moveSection, normalizeToolbar, rename, setKept, type ToolbarPrefs } from './toolbar.ts'

test('saved toolbar preferences drop unknown sections and add missing ones', () => {
  // Goals was a section until it was removed; preferences saved then still name it.
  const prefs = normalizeToolbar({ open: true, order: ['browser', 'nope', 'goals', 'library', 'browser'], kept: ['tools', 'tools', 'goals', 7], names: { chats: '  History  ', library: 'Library', goals: 'Aims', bogus: 'x' } })
  assert.deepEqual(prefs.order, ['browser', 'library', 'chats', 'tools'])
  assert.deepEqual(prefs.kept, ['tools'])
  assert.deepEqual(prefs.names, { chats: 'History' })
  assert.equal(prefs.open, true)
  assert.deepEqual(normalizeToolbar(null), DEFAULT_TOOLBAR)
  assert.deepEqual(normalizeToolbar('junk'), DEFAULT_TOOLBAR)
})

test('preferences saved when Tools was Evals keep its place, pin and label under tools', () => {
  const prefs = normalizeToolbar({ order: ['evals', 'browser', 'chats', 'library'], kept: ['evals', 'tools'], names: { evals: 'Ledger' } })
  assert.deepEqual(prefs.order, ['tools', 'browser', 'chats', 'library'])
  assert.deepEqual(prefs.kept, ['tools'])
  assert.deepEqual(prefs.names, { tools: 'Ledger' })
  assert.equal(accessibleName(prefs, 'tools'), 'Ledger (Tools)')
  // A label that was only the old default is not carried over as a custom name.
  assert.deepEqual(normalizeToolbar({ names: { evals: 'Tools' } }).names, {})
})

test('renaming keeps the real name for screen readers, and a blank or default name clears it', () => {
  let prefs: ToolbarPrefs = { ...DEFAULT_TOOLBAR, names: rename(DEFAULT_TOOLBAR, 'chats', 'History') }
  assert.equal(accessibleName(prefs, 'chats'), 'History (Chats)')
  assert.equal(accessibleName(prefs, 'library'), 'Library')
  prefs = { ...prefs, names: rename(prefs, 'chats', '   ') }
  assert.deepEqual(prefs.names, {})
  assert.deepEqual(rename(prefs, 'tools', 'Tools'), {})
  assert.equal(rename(prefs, 'tools', 'x'.repeat(40)).tools?.length, 24)
})

test('keeping and moving sections splits them between the toolbar and the drawer in order', () => {
  let prefs: ToolbarPrefs = { ...DEFAULT_TOOLBAR }
  prefs = { ...prefs, kept: setKept(prefs, 'browser', true) }
  prefs = { ...prefs, kept: setKept(prefs, 'chats', true) }
  prefs = { ...prefs, order: moveSection(prefs.order, 'browser', 'library') }
  assert.deepEqual(prefs.order, ['chats', 'browser', 'library', 'tools'])
  assert.deepEqual(arrange(prefs), { kept: ['chats', 'browser'], drawer: ['library', 'tools'] })
  prefs = { ...prefs, kept: setKept(prefs, 'chats', false) }
  assert.deepEqual(arrange(prefs).kept, ['browser'])
  assert.deepEqual(moveSection(prefs.order, 'chats', null), ['browser', 'library', 'tools', 'chats'])
  assert.deepEqual(moveSection(prefs.order, 'chats', 'chats'), prefs.order)
})
