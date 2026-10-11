import assert from 'node:assert/strict'
import test from 'node:test'
import { CRAFT_APPS, bridgeArgs, craftApp, keyFilePath, launchArgs, releaseUrl } from './craft-apps.ts'

const IDS = ['photocraft', 'vectorcraft', 'filmcraft', 'lightcraft', 'pdfcraft', 'effectcraft', 'designcraft', 'soundcraft', 'deckcraft', 'cadcraft', 'wordcraft', 'gridcraft']

test('the manifest has the twelve apps, each with a pinned and checkable release', () => {
  assert.deepEqual(CRAFT_APPS.map((app) => app.id), IDS)
  for (const app of CRAFT_APPS) {
    assert.match(app.version, /^\d+\.\d+\.\d+$/, app.id)
    assert.equal(app.tag, `v${app.version}`)
    assert.equal(app.repo, `storytold/${app.id}`)
    assert.equal(app.asset, `${app.id}-${app.version}-linux-x86_64.tar.gz`)
    assert.equal(app.folder, `${app.id}-${app.version}-linux-x86_64`)
    assert.match(app.sha256, /^[0-9a-f]{64}$/, app.id)
    assert.ok(app.downloadBytes > 10_000_000 && app.downloadBytes < 200_000_000, app.id)
    assert.ok(app.unpackedBytes > app.downloadBytes, app.id)
    assert.equal(app.bin, `bin/${app.id}`)
    assert.equal(app.cli, `bin/${app.id}-cli`)
    assert.match(app.accent, /^#[0-9a-f]{6}$/)
    assert.equal(app.initials.length, 2)
    assert.ok(app.extensions.length > 0 && app.extensions.every((ext) => /^[a-z0-9]+$/.test(ext)), app.id)
    assert.match(app.verified, /^\d{4}-\d{2}-\d{2}$/)
  }
  assert.equal(new Set(CRAFT_APPS.map((app) => app.sha256)).size, 12)
  assert.equal(new Set(CRAFT_APPS.map((app) => app.shortName)).size, 12)
})

test('nothing the user sees carries the ArtCraft trademark', () => {
  for (const app of CRAFT_APPS) {
    for (const text of [app.name, app.likeName, app.shortName, app.description, app.initials]) {
      assert.doesNotMatch(text, /artcraft/i, app.id)
    }
  }
})

test('release files come from the pinned GitHub release over HTTPS', () => {
  const grid = craftApp('gridcraft')!
  assert.equal(releaseUrl(grid, grid.asset), 'https://github.com/storytold/gridcraft/releases/download/v0.5.0/gridcraft-0.5.0-linux-x86_64.tar.gz')
  assert.equal(releaseUrl(grid, 'SHA256SUMS.txt'), 'https://github.com/storytold/gridcraft/releases/download/v0.5.0/SHA256SUMS.txt')
})

test('PhotoCraft starts with its port, token file and the chat folder as both roots', () => {
  const photo = craftApp('photocraft')!
  assert.deepEqual(launchArgs(photo, { port: 47001, tokenFile: '/run/t', folder: '/work' }), [
    '--control', '47001', '--control-token-file', '/run/t', '--automation-read-root', '/work', '--automation-write-root', '/work'
  ])
  assert.throws(() => launchArgs(photo, { port: 47001 }), /control token/)
  assert.deepEqual(bridgeArgs(photo, { port: 47001, tokenFile: '/run/t' }), ['mcp', '--bridge', '127.0.0.1:47001', '--control-token-file', '/run/t'])
})

test('apps without tokens or roots get only their port, and every bridge gets host:port', () => {
  const grid = craftApp('gridcraft')!
  assert.deepEqual(launchArgs(grid, { port: 5000, folder: '/work' }), ['--control', '5000'])
  assert.throws(() => launchArgs(grid, {}), /control port/)
  // LightCraft misreads a bare port as a file to open; every bridge is given 127.0.0.1:<port>.
  for (const app of CRAFT_APPS) {
    const args = bridgeArgs(app, { port: 5000, tokenFile: '/t' })
    if (args) assert.ok(args.includes('127.0.0.1:5000'), app.id)
  }
  assert.deepEqual(bridgeArgs(craftApp('filmcraft')!, { port: 5000 }), ['mcp', '--bridge', '127.0.0.1:5000'])
  assert.deepEqual(bridgeArgs(craftApp('lightcraft')!, { port: 5000 }), ['mcp', '--connect', '127.0.0.1:5000'])
})

test('VectorCraft takes roots without a token; PdfCraft takes a control file and has no bridge', () => {
  assert.deepEqual(launchArgs(craftApp('vectorcraft')!, { port: 1, folder: '/w' }), ['--control', '1', '--automation-read-root', '/w', '--automation-write-root', '/w'])
  const pdf = craftApp('pdfcraft')!
  assert.deepEqual(launchArgs(pdf, { controlFile: '/run/pdf.json', folder: '/w' }), ['--control', '/run/pdf.json'])
  assert.throws(() => launchArgs(pdf, { port: 1 }), /control file/)
  assert.equal(bridgeArgs(pdf, { port: 1 }), null)
})

test('WordCraft’s own key file is found under its config folder by port', () => {
  assert.equal(keyFilePath(craftApp('wordcraft')!, 7981), 'wordcraft/control-key.local-7981')
  assert.equal(keyFilePath(craftApp('gridcraft')!, 7981), null)
})
