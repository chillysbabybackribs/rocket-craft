import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { craftApp } from '../shared/craft-apps.ts'
import { mergeSeed, seedAppSettings } from './craft-seed.ts'

const photo = craftApp('photocraft')!
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

test('mergeSeed applies the seeded keys and keeps every other value', () => {
  const merged = mergeSeed({ interface: { theme: 'light', systemTitleBar: false }, extra: 1 }, { interface: { systemTitleBar: true, x: 2 }, general: { a: false } })
  assert.deepEqual(merged, { interface: { theme: 'light', systemTitleBar: true, x: 2 }, extra: 1, general: { a: false } })
})

test('a fresh config home gets the seed file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seed-'))
  assert.equal(await seedAppSettings(photo, home), null)
  assert.deepEqual(await read(join(home, 'photocraft/preferences.json')), { interface: { systemTitleBar: true }, general: { autoShowHomeScreen: false } })
})

test('a default the app saved earlier is overridden, and the user\'s other settings are kept', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seed-'))
  await mkdir(join(home, 'photocraft'), { recursive: true })
  await writeFile(join(home, 'photocraft/preferences.json'), JSON.stringify({ general: { autoShowHomeScreen: true, units: 'px' } }))
  assert.equal(await seedAppSettings(photo, home), null)
  assert.deepEqual(await read(join(home, 'photocraft/preferences.json')), { general: { autoShowHomeScreen: false, units: 'px' }, interface: { systemTitleBar: true } })
})

test('a malformed file is left alone and reported in a sentence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seed-'))
  await mkdir(join(home, 'photocraft'), { recursive: true })
  const file = join(home, 'photocraft/preferences.json')
  await writeFile(file, '{ not json')
  const message = await seedAppSettings(photo, home)
  assert.match(message!, /could not be read.*left as it is.*Delete the file/)
  assert.equal(await readFile(file, 'utf8'), '{ not json')
  await writeFile(file, '[1]')
  assert.match((await seedAppSettings(photo, home))!, /does not hold a JSON object/)
})

test('VectorCraft and WordCraft seeds land in their own files; apps without seeds do nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seed-'))
  await seedAppSettings(craftApp('vectorcraft')!, home)
  await seedAppSettings(craftApp('wordcraft')!, home)
  assert.deepEqual(await read(join(home, 'vectorcraft/ui.json')), { engine_prefs: { showHomeScreen: false, systemTitleBar: true } })
  assert.deepEqual(await read(join(home, 'wordcraft/ui.json')), { showDiscord: false })
  assert.equal(await seedAppSettings(craftApp('effectcraft')!, home), null)
})
