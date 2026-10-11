import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import {
  chromiumTime,
  decryptChromium,
  deriveChromiumKey,
  hostMatches,
  mapSameSite,
  toElectronCookie,
  type RawCookie
} from './cookie-import.ts'

// Encrypt a value the way Chromium does on Linux, so decryptChromium can be tested without a
// keyring or a real profile: v10/v11 tag, AES-128-CBC, the 32-byte host hash prepended.
function encryptLikeChromium(plaintext: string, key: Buffer, tag: 'v10' | 'v11'): Buffer {
  const iv = Buffer.alloc(16, ' ')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const body = Buffer.concat([Buffer.alloc(32, 7), Buffer.from(plaintext, 'utf8')])
  return Buffer.concat([Buffer.from(tag, 'latin1'), cipher.update(body), cipher.final()])
}

describe('chromium cookie decryption', () => {
  const key = deriveChromiumKey('a-fake-safe-storage-password')

  it('recovers a v11 value, dropping the tag and the 32-byte host hash', () => {
    const encrypted = encryptLikeChromium('session=abc123; wanted', key, 'v11')
    assert.equal(decryptChromium(encrypted, key), 'session=abc123; wanted')
  })

  it('recovers a v10 value the same way', () => {
    const encrypted = encryptLikeChromium('v10-secret', key, 'v10')
    assert.equal(decryptChromium(encrypted, key), 'v10-secret')
  })

  it('returns null for an untagged or empty blob', () => {
    assert.equal(decryptChromium(Buffer.from('plain'), key), null)
    assert.equal(decryptChromium(null, key), null)
    assert.equal(decryptChromium(Buffer.from([1, 2]), key), null)
  })

  it('returns null when the key is wrong rather than throwing', () => {
    const encrypted = encryptLikeChromium('secret', key, 'v11')
    const wrong = deriveChromiumKey('different-password')
    // A wrong key may yield garbage or fail padding; either way it must not throw.
    assert.doesNotThrow(() => decryptChromium(encrypted, wrong))
  })
})

describe('chromium timestamps', () => {
  it('converts microseconds since 1601 to Unix seconds', () => {
    // 13 463 585 908 935 752 µs since 1601 is a real cookie expiry well beyond 2 ** 53 µs.
    assert.equal(chromiumTime(13_463_585_908_935_752n), 1_819_112_308)
  })

  it('treats a zero or negative expiry as a session cookie', () => {
    assert.equal(chromiumTime(0n), 0)
    assert.equal(chromiumTime(-5n), 0)
  })
})

describe('sameSite mapping', () => {
  it('maps Chromium codes to Electron values', () => {
    assert.equal(mapSameSite(2, true), 'strict')
    assert.equal(mapSameSite(1, false), 'lax')
    assert.equal(mapSameSite(0, true), 'no_restriction')
    assert.equal(mapSameSite(-1, true), 'unspecified')
  })

  it('downgrades insecure SameSite=None to lax so it is not rejected', () => {
    assert.equal(mapSameSite(0, false), 'lax')
  })
})

describe('host matching for site-only import', () => {
  it('matches host-only and domain cookies for the same site', () => {
    assert.ok(hostMatches('claude.ai', 'claude.ai'))
    assert.ok(hostMatches('.claude.ai', 'claude.ai'))
    assert.ok(hostMatches('.claude.ai', 'app.claude.ai'))
    assert.ok(hostMatches('app.claude.ai', 'claude.ai'))
  })

  it('does not match an unrelated site', () => {
    assert.ok(!hostMatches('.twitter.com', 'claude.ai'))
    assert.ok(!hostMatches('notclaude.ai', 'claude.ai'))
  })
})

describe('conversion to an Electron cookie', () => {
  const base: RawCookie = {
    host: '.claude.ai',
    name: 'sid',
    value: 'abc',
    path: '/',
    expires: 1_819_112_308,
    secure: true,
    httpOnly: true,
    sameSite: 1
  }

  it('builds a domain cookie with an https url and expiry', () => {
    const details = toElectronCookie(base)
    assert.equal(details.url, 'https://claude.ai/')
    assert.equal(details.domain, '.claude.ai')
    assert.equal(details.secure, true)
    assert.equal(details.httpOnly, true)
    assert.equal(details.sameSite, 'lax')
    assert.equal(details.expirationDate, 1_819_112_308)
  })

  it('builds a host-only cookie without a domain, and an http url when insecure', () => {
    const details = toElectronCookie({ ...base, host: 'accounts.google.com', secure: false })
    assert.equal(details.url, 'http://accounts.google.com/')
    assert.equal(details.domain, undefined)
    assert.equal(details.secure, false)
  })

  it('leaves expirationDate unset for a session cookie', () => {
    const details = toElectronCookie({ ...base, expires: 0 })
    assert.equal(details.expirationDate, undefined)
  })
})
