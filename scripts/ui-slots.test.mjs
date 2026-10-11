import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquireUiSlots,
  isExclusiveUiCheck,
  pidAlive,
  slotCount,
  DEFAULT_SLOT_DIR
} from './ui-slots.mjs'

test('slot count follows cores with CRAFT_UI_SLOTS override', () => {
  const cores = 8
  assert.equal(slotCount({ CRAFT_UI_SLOTS: '3' }), 3)
  assert.equal(slotCount({ CRAFT_UI_SLOTS: '0' }), Math.max(1, Math.floor(cores / 4)))
  assert.equal(slotCount({}), Math.max(1, Math.floor(cores / 4)))
})

test('exclusive runs are detected from argv', () => {
  assert.equal(isExclusiveUiCheck([]), true)
  assert.equal(isExclusiveUiCheck(['tests/ui/toolbar.spec.ts']), false)
  assert.equal(isExclusiveUiCheck(['tests/ui/long-chat.spec.ts']), true)
  assert.equal(isExclusiveUiCheck(['--grep', 'orchestra-stress']), true)
})

test('a stale pid is taken over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocket-ui-slots-stale-'))
  try {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify({ pid: 9_999_999, started: 0 }))
    assert.equal(pidAlive(9_999_999), false)
    const lock = await acquireUiSlots({ dir, count: 1, pollMs: 50 })
    assert.deepEqual(lock.slots, [0])
    const onDisk = JSON.parse(await readFile(join(dir, 'slot-0.json'), 'utf8'))
    assert.equal(onDisk.pid, process.pid)
    await lock.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two slots taken makes a third wait until one frees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocket-ui-slots-wait-'))
  const env = { CRAFT_UI_SLOTS: '2' }
  try {
    const first = await acquireUiSlots({ dir, count: 2, pollMs: 50, env })
    const second = await acquireUiSlots({ dir, count: 2, pollMs: 50, env })
    assert.deepEqual(first.slots, [0])
    assert.deepEqual(second.slots, [1])

    let thirdStarted = false
    const third = acquireUiSlots({ dir, count: 2, pollMs: 50, env }).then(lock => {
      thirdStarted = true
      return lock
    })

    await delay(120)
    assert.equal(thirdStarted, false)

    await first.release()
    const thirdLock = await third
    assert.equal(thirdStarted, true)
    assert.deepEqual(thirdLock.slots, [0])

    await second.release()
    await thirdLock.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an exclusive run waits for both slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocket-ui-slots-exclusive-'))
  const env = { CRAFT_UI_SLOTS: '2' }
  try {
    const a = await acquireUiSlots({ dir, count: 2, pollMs: 50, env })
    const b = await acquireUiSlots({ dir, count: 2, pollMs: 50, env })
    assert.deepEqual(a.slots, [0])
    assert.deepEqual(b.slots, [1])

    let exclusiveStarted = false
    const exclusive = acquireUiSlots({ dir, count: 2, exclusive: true, pollMs: 50, env }).then(lock => {
      exclusiveStarted = true
      return lock
    })

    await delay(120)
    assert.equal(exclusiveStarted, false)

    await a.release()
    await delay(120)
    assert.equal(exclusiveStarted, false)

    await b.release()
    const lock = await exclusive
    assert.equal(exclusiveStarted, true)
    assert.deepEqual(lock.slots, [0, 1])
    await lock.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('default slot dir lives under the OS temp directory', () => {
  assert.ok(DEFAULT_SLOT_DIR.startsWith(tmpdir()))
  assert.match(DEFAULT_SLOT_DIR, /rocket-ui-slots/)
})
