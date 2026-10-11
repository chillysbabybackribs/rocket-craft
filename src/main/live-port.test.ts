import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publishLivePort, readLiveEndpoint } from './live-port.ts'

test('live endpoint ignores overwritten Chromium metadata and tracks the lock owner', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'rocket-live-port-test-'))
  try {
    await publishLivePort(profile, 123, 33673)
    await writeFile(join(profile, 'DevToolsActivePort'), '42989\n/devtools/browser/stray\n')
    assert.equal(await readLiveEndpoint(profile, 123), 'http://127.0.0.1:33673')
    await assert.rejects(readLiveEndpoint(profile, 456), /Restart Craft Studio/)
    await publishLivePort(profile, 456, 33674)
    assert.equal(await readLiveEndpoint(profile, 456), 'http://127.0.0.1:33674')
    await assert.rejects(readLiveEndpoint(profile, 123), /Restart Craft Studio/)
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('live endpoint rejects malformed and invalid port records', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'rocket-live-port-test-'))
  try {
    await assert.rejects(readLiveEndpoint(profile, 123))
    for (const record of [null, {}, { pid: 123, port: '33673' }, { pid: 123, port: 0 }, { pid: 123, port: 65536 }, { pid: 123, port: 1.5 }]) {
      await writeFile(join(profile, 'live-port.json'), JSON.stringify(record))
      await assert.rejects(readLiveEndpoint(profile, 123), /Restart Craft Studio/)
    }
    await writeFile(join(profile, 'live-port.json'), '{')
    await assert.rejects(readLiveEndpoint(profile, 123), SyntaxError)
  } finally { await rm(profile, { recursive: true, force: true }) }
})
