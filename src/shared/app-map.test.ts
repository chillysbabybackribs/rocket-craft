import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ACTIONS, PLACES, describeMap, isAction, isPlace } from './app-map.ts'

const root = resolve(import.meta.dirname, '../..')

/** Every renderer source file, read whole. */
function rendererSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push({ path, text: readFileSync(path, 'utf8') })
    }
  }
  walk(join(root, 'src/renderer/src'))
  return out
}

// The map and the UI must name the same things. A button that calls go/act with a name the map
// lacks, or a map entry no control uses, is drift in one direction or the other; the dispatcher
// itself is excluded, since it implements every name by construction.
test('every map name has a control in the renderer, and every name a control uses is in the map', () => {
  const sources = rendererSources().filter((file) => !file.path.endsWith('/app-map.ts'))
  const used = new Map<string, string>()
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/\b(?:go|act)\(\s*'([^']+)'/g)) used.set(match[1]!, path)
    for (const match of text.matchAll(/data-nav="([^"]+)"/g)) used.set(match[1]!, path)
    for (const match of text.matchAll(/place:\s*'([^']+)'/g)) used.set(match[1]!, path)
  }
  for (const [name, path] of used) {
    if (name === 'browser') continue // A side panel's name, not a place.
    assert.ok(isPlace(name) || isAction(name), `${path} uses "${name}", which is not in the app map`)
  }
  for (const name of [...Object.keys(PLACES), ...Object.keys(ACTIONS)]) {
    assert.ok(used.has(name), `the app map names ${name}, but no renderer control uses it`)
  }
})

test('every place names a component file that exists', () => {
  for (const [name, spec] of Object.entries(PLACES)) assert.ok(existsSync(join(root, spec.file)), `${name} → ${spec.file}`)
})

test('every action with a place names a place that exists, and names are well formed', () => {
  for (const [name, spec] of Object.entries(ACTIONS)) {
    assert.match(name, /^[a-z]+(\.[a-zA-Z]+)+$/, `action ${name}`)
    if ('place' in spec && spec.place) assert.ok(isPlace(spec.place), `action ${name} belongs to unknown place ${spec.place}`)
  }
  for (const [name, spec] of Object.entries(PLACES)) {
    assert.match(name, /^[a-z]+(\.[a-zA-Z]+)*$/, `place ${name}`)
    assert.match(spec.file, /^src\/renderer\//, `place ${name} names its component`)
  }
  assert.ok(isPlace('app') && isPlace('shelf') && isAction('app.show') && isAction('shelf.open'))
  assert.ok(!isPlace('app.nowhere'))
  // Models never install or remove an app, and the tool ledger's panel was dropped.
  for (const name of [...Object.keys(PLACES), ...Object.keys(ACTIONS)]) assert.doesNotMatch(name, /install|remove|tools/)
  // The eval scenario panel is gone; its names must not linger in the map.
  assert.ok(!isPlace('evals.scenario') && !isPlace('evals.tools') && !isAction('evals.run.start'))
  assert.ok(!isAction('toString'))
})

test('the map prints every place and action with its parameters', () => {
  const text = describeMap()
  for (const name of Object.keys(PLACES)) assert.ok(text.includes(`- ${name}`), name)
  for (const name of Object.keys(ACTIONS)) assert.ok(text.includes(`- ${name}`), name)
  assert.ok(text.includes('chatId: chat id (required)'))
  assert.ok(text.indexOf('Places (studio_ui_go)') < text.indexOf('Actions (studio_ui_act)'))
})

 test('run controls remain in place and explain drain and paused-only resume', () => {
  assert.ok(isAction('run.wrapUp') && isAction('run.resume'))
  assert.ok(!('place' in ACTIONS['run.wrapUp']) && !('place' in ACTIONS['run.resume']))
  assert.match(ACTIONS['run.wrapUp'].description, /cancel queued workers/)
  assert.match(ACTIONS['run.resume'].description, /only while paused/)
})
