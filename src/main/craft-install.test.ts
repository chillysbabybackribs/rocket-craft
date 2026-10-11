import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CraftAppManifest } from '../shared/craft-apps.ts'
import { CraftInstaller, checkMembers, craftAppsHome, sumFor, type InstallEvent } from './craft-install.ts'

// A fake app: a tiny tarball laid out like a real release, served from a loopback server.

type Fixture = { dir: string; tarball: Buffer; sha: string; app: CraftAppManifest; files: Map<string, Buffer | string>; server: Server; base: string; requests: string[] }

async function fixture(options: { members?: (folder: string) => Promise<void>; tamper?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-install-test-'))
  const folder = 'fakecraft-1.2.3-linux-x86_64'
  const source = join(dir, 'source')
  await mkdir(join(source, folder, 'bin'), { recursive: true })
  for (const name of ['fakecraft', 'fakecraft-cli']) {
    await writeFile(join(source, folder, 'bin', name), '#!/bin/sh\necho fake\n')
    await chmod(join(source, folder, 'bin', name), 0o755)
  }
  await mkdir(join(source, folder, 'share'), { recursive: true })
  await writeFile(join(source, folder, 'share', 'notes.txt'), 'x'.repeat(5000))
  await options.members?.(source)
  const archive = join(dir, 'fake.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', source, ...(await import('node:fs')).readdirSync(source)])
  const tarball = await readFile(archive)
  const sha = createHash('sha256').update(tarball).digest('hex')
  const asset = 'fakecraft-1.2.3-linux-x86_64.tar.gz'
  const app: CraftAppManifest = {
    id: 'fakecraft', name: 'FakeCraft', likeName: 'Nothing', shortName: 'Fake', initials: 'Fa', accent: '#123456',
    description: 'A test app', repo: 'test/fakecraft', version: '1.2.3', tag: 'v1.2.3', asset, sha256: sha,
    downloadBytes: tarball.length, unpackedBytes: 6000, folder, bin: 'bin/fakecraft', cli: 'bin/fakecraft-cli',
    control: { kind: 'port', flag: '--control' }, auth: { kind: 'none' }, roots: null, bridge: null, extensions: ['fake'], verified: '2026-10-11'
  }
  const files = new Map<string, Buffer | string>([
    [asset, options.tamper ? Buffer.concat([tarball.subarray(0, tarball.length - 1), Buffer.from([tarball[tarball.length - 1]! ^ 1])]) : tarball],
    ['SHA256SUMS.txt', `0000000000000000000000000000000000000000000000000000000000000000  other.AppImage\n${sha}  ${asset}\n`]
  ])
  const requests: string[] = []
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
    requests.push(name)
    const body = files.get(name)
    if (body === undefined) { res.writeHead(404).end('missing'); return }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) })
    // Several chunks, so progress has something to report.
    const buffer = Buffer.from(body)
    let offset = 0
    const step = (): void => {
      if (offset >= buffer.length) { res.end(); return }
      res.write(buffer.subarray(offset, offset + 1024))
      offset += 1024
      setImmediate(step)
    }
    step()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { dir, tarball, sha, app, files, server, base, requests }
}

async function done(f: Fixture): Promise<void> {
  await new Promise((resolve) => f.server.close(resolve))
  await rm(f.dir, { recursive: true, force: true })
}

function installer(f: Fixture, events: InstallEvent[] = [], profile = 'profile', options: { allowLoopbackHttp?: boolean } = {}): CraftInstaller {
  return new CraftInstaller({
    home: join(f.dir, 'home'),
    profileFile: join(f.dir, profile, 'craft-apps.json'),
    apps: [f.app],
    urlOf: (_app, file) => `${f.base}/${file}`,
    allowLoopbackHttp: options.allowLoopbackHttp ?? true,
    onEvent: (event) => events.push(event),
    idleTimeoutMs: 5000
  })
}

test('installs the pinned release: verified, unpacked, recorded, with progress', async () => {
  const f = await fixture()
  try {
    const events: InstallEvent[] = []
    const inst = installer(f, events)
    const record = await inst.install('fakecraft')
    assert.equal(record.version, '1.2.3')
    assert.equal(record.sha256, f.sha)
    const dir = join(f.dir, 'home', 'apps', 'fakecraft', '1.2.3')
    assert.ok((await stat(join(dir, 'bin', 'fakecraft'))).mode & 0o100)
    assert.ok(record.sizeBytes >= 5000)
    assert.deepEqual(await inst.list(), [record])
    assert.equal((await inst.binaries('fakecraft'))?.bin, join(dir, 'bin', 'fakecraft'))
    const progress = events.filter((event) => event.state === 'installing').map((event) => event.state === 'installing' ? event.progress : -1)
    assert.ok(progress.length >= 3, `progress events: ${progress.join(',')}`)
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b))
    assert.equal(events.at(-1)?.state, 'installed')
    // The working folder with the archive is gone.
    const left = (await import('node:fs')).readdirSync(join(f.dir, 'home', 'apps', 'fakecraft'))
    assert.deepEqual(left, ['1.2.3'])
  } finally { await done(f) }
})

test('a second install while one runs joins it instead of downloading twice', async () => {
  const f = await fixture()
  try {
    const inst = installer(f)
    const [a, b] = await Promise.all([inst.install('fakecraft'), inst.install('fakecraft')])
    assert.deepEqual(a, b)
    assert.equal(f.requests.filter((name) => name === f.app.asset).length, 1)
  } finally { await done(f) }
})

test('another profile adopts an install already on disk without downloading', async () => {
  const f = await fixture()
  try {
    await installer(f, [], 'one').install('fakecraft')
    const count = f.requests.length
    const other = installer(f, [], 'two')
    assert.deepEqual(await other.list(), [])
    await other.install('fakecraft')
    assert.equal(f.requests.length, count)
    assert.equal((await other.list()).length, 1)
  } finally { await done(f) }
})

test('a release republished under the same version is refused', async () => {
  const f = await fixture()
  try {
    f.files.set('SHA256SUMS.txt', `${'a'.repeat(64)}  ${f.app.asset}\n`)
    const events: InstallEvent[] = []
    await assert.rejects(installer(f, events).install('fakecraft'), /republished upstream/)
    assert.equal(events.at(-1)?.state, 'failed')
    assert.ok(!f.requests.includes(f.app.asset), 'the archive is not downloaded at all')
  } finally { await done(f) }
})

test('a download that does not match its checksum is not installed', async () => {
  const f = await fixture({ tamper: true })
  try {
    const inst = installer(f)
    await assert.rejects(inst.install('fakecraft'), /did not match its checksum/)
    assert.deepEqual(await inst.list(), [])
    assert.deepEqual((await import('node:fs')).readdirSync(join(f.dir, 'home', 'apps', 'fakecraft')), [])
  } finally { await done(f) }
})

test('a checksum list without the asset, a missing file and plain HTTP are all refused', async () => {
  const f = await fixture()
  try {
    f.files.set('SHA256SUMS.txt', `${f.sha}  something-else.tar.gz\n`)
    await assert.rejects(installer(f).install('fakecraft'), /does not include/)
    f.files.delete('SHA256SUMS.txt')
    await assert.rejects(installer(f).install('fakecraft'), /answered 404/)
    await assert.rejects(installer(f, [], 'p', { allowLoopbackHttp: false }).install('fakecraft'), /not served over HTTPS/)
    await assert.rejects(installer(f).install('nosuchcraft'), /no app called/)
  } finally { await done(f) }
})

test('an archive with files outside its folder is refused before unpacking', async () => {
  const f = await fixture({ members: async (source) => { await writeFile(join(source, 'stray.txt'), 'outside') } })
  try {
    await assert.rejects(installer(f).install('fakecraft'), /outside fakecraft-1.2.3-linux-x86_64/)
  } finally { await done(f) }
})

test('member checks catch parent paths and absolute names', () => {
  assert.equal(checkMembers(['app/', 'app/bin/x'], 'app'), null)
  assert.match(checkMembers(['app/../../etc/passwd'], 'app')!, /unsafe/)
  assert.match(checkMembers(['/etc/passwd'], 'app')!, /unsafe/)
  assert.match(checkMembers([], 'app')!, /empty/)
})

test('a link pointing out of the app is refused', async () => {
  const f = await fixture({ members: async (source) => {
    const { symlink } = await import('node:fs/promises')
    await symlink('/etc/passwd', join(source, 'fakecraft-1.2.3-linux-x86_64', 'share', 'escape'))
  } })
  try {
    await assert.rejects(installer(f).install('fakecraft'), /link that points outside/)
  } finally { await done(f) }
})

test('remove deletes the app and its record but keeps its settings', async () => {
  const f = await fixture()
  try {
    const events: InstallEvent[] = []
    const inst = installer(f, events)
    await inst.install('fakecraft')
    await mkdir(join(inst.settingsOf('fakecraft'), 'config'), { recursive: true })
    await writeFile(join(inst.settingsOf('fakecraft'), 'config', 'prefs'), 'keep me')
    await inst.remove('fakecraft')
    assert.deepEqual(await inst.list(), [])
    await assert.rejects(stat(join(f.dir, 'home', 'apps', 'fakecraft')))
    assert.equal(await readFile(join(inst.settingsOf('fakecraft'), 'config', 'prefs'), 'utf8'), 'keep me')
    assert.equal(events.at(-1)?.state, 'none')
    await assert.rejects(inst.remove('../../etc'), /no app called/)
  } finally { await done(f) }
})

test('checksum lists are read in both text and binary mode', () => {
  const sums = `${'b'.repeat(64)}  a.tar.gz\n${'C'.repeat(64)} *b.tar.gz\n`
  assert.equal(sumFor(sums, 'a.tar.gz'), 'b'.repeat(64))
  assert.equal(sumFor(sums, 'b.tar.gz'), 'c'.repeat(64))
  assert.equal(sumFor(sums, 'c.tar.gz'), null)
})

test('the apps home honours CRAFT_APPS_DIR, then XDG_DATA_HOME', () => {
  assert.equal(craftAppsHome({ CRAFT_APPS_DIR: '/tmp/x' }), '/tmp/x')
  assert.equal(craftAppsHome({ XDG_DATA_HOME: '/data' }), '/data/craft-studio')
  assert.match(craftAppsHome({}), /\.local\/share\/craft-studio$/)
})
