// Bring the user's logged-in sessions from their own OS browser into Craft Studio's embedded browser,
// so a site they are signed into out there is signed into here too. Cookies are read from the
// browser's own profile on disk, decrypted, and written into the `persist:browser` session, which
// keeps them on disk itself — so an import survives restarts without anything extra.
//
// Two families are handled:
// - Chromium (Chrome, Chromium, Brave, Edge, Vivaldi): the cookie value is AES-128-CBC encrypted
//   with a key derived from a password kept in the login keyring ("<Browser> Safe Storage"). The
//   plaintext of a modern profile (cookie DB v24+) is prefixed with a 32-byte SHA-256 of the host,
//   which Chromium checks and we drop. v10-tagged values predate the keyring and use a fixed
//   password ("peanuts"); v11 is the keyring one. Verified against Chrome 152 on Linux, 2026-10-06.
// - Firefox: cookies.sqlite is not encrypted; the columns are read as they are.
//
// The browser may be running while we read, so its Cookies file is copied to a temp path first;
// SQLite is opened read-only on the copy. We only ever read the user's profile, never write to it.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Session } from 'electron'

/** An OS browser profile Craft Studio can pull cookies from. */
export type CookieSource = {
  /** Stable id used by the menu and the first-run marker. */
  id: string
  /** What the user sees, e.g. "Google Chrome". */
  label: string
  family: 'chromium' | 'firefox'
  /** The Cookies SQLite file in the browser's profile. */
  cookiePath: string
  /** Chromium only: the keyring application the Safe Storage password is stored under. */
  keyringApp?: string
}

export type ImportResult = { imported: number; skipped: number }

type Candidate = Omit<CookieSource, 'cookiePath'> & { dir: string }

const HOME = homedir()

// Where each browser keeps its default profile, and the keyring application its Safe Storage
// password is filed under. The directory is the profile root; the Cookies file sits in Default/
// (Chromium) or is found by scanning (Firefox). Order is the order shown in the menu.
const CHROMIUM: Candidate[] = [
  { id: 'chrome', label: 'Google Chrome', family: 'chromium', keyringApp: 'chrome', dir: join(HOME, '.config/google-chrome') },
  { id: 'chromium', label: 'Chromium', family: 'chromium', keyringApp: 'chromium', dir: join(HOME, '.config/chromium') },
  { id: 'brave', label: 'Brave', family: 'chromium', keyringApp: 'brave', dir: join(HOME, '.config/BraveSoftware/Brave-Browser') },
  { id: 'edge', label: 'Microsoft Edge', family: 'chromium', keyringApp: 'microsoft-edge', dir: join(HOME, '.config/microsoft-edge') },
  { id: 'vivaldi', label: 'Vivaldi', family: 'chromium', keyringApp: 'vivaldi', dir: join(HOME, '.config/vivaldi') }
]

const FIREFOX_ROOTS = [
  join(HOME, '.mozilla/firefox'),
  join(HOME, 'snap/firefox/common/.mozilla/firefox'),
  join(HOME, '.var/app/org.mozilla.firefox/.mozilla/firefox')
]

/** The OS browsers that actually have a cookie store right now, in menu order. */
export function detectCookieSources(): CookieSource[] {
  const found: CookieSource[] = []
  for (const c of CHROMIUM) {
    const cookiePath = join(c.dir, 'Default', 'Cookies')
    if (existsSync(cookiePath)) found.push({ id: c.id, label: c.label, family: c.family, keyringApp: c.keyringApp, cookiePath })
  }
  const firefox = firefoxCookiePath()
  if (firefox) found.push({ id: 'firefox', label: 'Firefox', family: 'firefox', cookiePath: firefox })
  return found
}

/** The source matching the OS default browser, so first-run import picks the obvious one. */
export function defaultCookieSource(sources: CookieSource[]): CookieSource | null {
  let desktop = ''
  try {
    desktop = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim().toLowerCase()
  } catch {
    // No xdg-settings, or no default set; fall through to first detected.
  }
  const match = (id: string) => desktop.includes(id)
  const picked =
    sources.find((s) => match(s.id)) ??
    (desktop.includes('google-chrome') ? sources.find((s) => s.id === 'chrome') : undefined) ??
    sources[0]
  return picked ?? null
}

/** Read a browser's cookies and write them into the given session. `host`, if set, limits to one site. */
export async function importCookies(session: Session, source: CookieSource, host?: string): Promise<ImportResult> {
  const rows = source.family === 'firefox' ? readFirefox(source) : readChromium(source)
  const wanted = host ? rows.filter((r) => hostMatches(r.host, host)) : rows
  let imported = 0
  let skipped = 0
  for (const cookie of wanted) {
    try {
      await session.cookies.set(toElectronCookie(cookie))
      imported++
    } catch {
      // A malformed or rejected cookie (e.g. an invalid name) is skipped; the rest still import.
      skipped++
    }
  }
  return { imported, skipped }
}

export type RawCookie = {
  host: string
  name: string
  value: string
  path: string
  /** Seconds since the Unix epoch, or 0 for a session cookie. */
  expires: number
  secure: boolean
  httpOnly: boolean
  /** Chromium/Firefox code: -1/unspecified, 0/none, 1/lax, 2/strict. */
  sameSite: number
}

function readChromium(source: CookieSource): RawCookie[] {
  const key = chromiumKey(source.keyringApp ?? 'chrome')
  const copy = copyLocked(source.cookiePath)
  try {
    const db = new DatabaseSync(copy, { readOnly: true })
    const stmt = db.prepare(
      'select host_key, name, encrypted_value, value, path, expires_utc, is_secure, is_httponly, samesite from cookies'
    )
    // expires_utc is microseconds since 1601, which overflows a JS double; read integers as BigInt.
    stmt.setReadBigInts(true)
    const rows = stmt.all() as Array<Record<string, unknown>>
    db.close()
    const out: RawCookie[] = []
    for (const r of rows) {
      const host = String(r.host_key ?? '')
      const name = String(r.name ?? '')
      if (!host || !name) continue
      const value = decryptChromium(r.encrypted_value as Uint8Array | null, key) ?? String(r.value ?? '')
      out.push({
        host,
        name,
        value,
        path: String(r.path ?? '/') || '/',
        expires: chromiumTime((r.expires_utc as bigint | null) ?? 0n),
        secure: Number(r.is_secure ?? 0n) === 1,
        httpOnly: Number(r.is_httponly ?? 0n) === 1,
        sameSite: Number(r.samesite ?? -1n)
      })
    }
    return out
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

function readFirefox(source: CookieSource): RawCookie[] {
  const copy = copyLocked(source.cookiePath)
  try {
    const db = new DatabaseSync(copy, { readOnly: true })
    const rows = db.prepare(
      'select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite from moz_cookies'
    ).all() as Array<Record<string, unknown>>
    db.close()
    const out: RawCookie[] = []
    for (const r of rows) {
      const host = String(r.host ?? '')
      const name = String(r.name ?? '')
      if (!host || !name) continue
      out.push({
        host,
        name,
        value: String(r.value ?? ''),
        path: String(r.path ?? '/') || '/',
        expires: Number(r.expiry ?? 0), // Firefox stores Unix seconds already.
        secure: Number(r.isSecure ?? 0) === 1,
        httpOnly: Number(r.isHttpOnly ?? 0) === 1,
        sameSite: Number(r.sameSite ?? -1)
      })
    }
    return out
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

// ── Chromium decryption ───────────────────────────────────────────────

function chromiumKey(app: string): Buffer {
  let password = 'peanuts'
  try {
    password = execFileSync(
      'secret-tool',
      ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', app],
      { encoding: 'utf8' }
    )
    // secret-tool returns the secret with no trailing newline; use it verbatim.
  } catch {
    // No keyring entry (or it is locked): only v10 "peanuts" values will decrypt.
  }
  return deriveChromiumKey(password)
}

/** The AES key Chromium derives from a Safe Storage password on Linux/macOS. */
export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
}

const CHROMIUM_IV = Buffer.alloc(16, ' ')

export function decryptChromium(encrypted: Uint8Array | null, key: Buffer): string | null {
  if (!encrypted || encrypted.length < 4) return null
  const buf = Buffer.from(encrypted)
  const tag = buf.subarray(0, 3).toString('latin1')
  if (tag !== 'v10' && tag !== 'v11') return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_IV)
    decipher.setAutoPadding(false)
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
    const pad = plain[plain.length - 1]
    if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad)
    // Cookie DB v24+ prepends a 32-byte SHA-256 of the host to the plaintext.
    if (plain.length >= 32) plain = plain.subarray(32)
    return plain.toString('utf8')
  } catch {
    return null
  }
}

/** Chromium timestamps are microseconds since 1601-01-01; convert to Unix seconds. */
export function chromiumTime(microsSince1601: bigint): number {
  if (microsSince1601 <= 0n) return 0
  return Number(microsSince1601 / 1_000_000n - 11_644_473_600n)
}

// ── Shared helpers ────────────────────────────────────────────────────

export function toElectronCookie(cookie: RawCookie): Electron.CookiesSetDetails {
  const domainCookie = cookie.host.startsWith('.')
  const bareHost = cookie.host.replace(/^\./, '')
  const scheme = cookie.secure ? 'https' : 'http'
  const sameSite = mapSameSite(cookie.sameSite, cookie.secure)
  const details: Electron.CookiesSetDetails = {
    url: `${scheme}://${bareHost}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite
  }
  if (domainCookie) details.domain = cookie.host
  // A zero expiry is a session cookie: leave expirationDate unset so it is treated as one.
  if (cookie.expires > 0) details.expirationDate = cookie.expires
  return details
}

export function mapSameSite(code: number, secure: boolean): Electron.CookiesSetDetails['sameSite'] {
  switch (code) {
    case 2: return 'strict'
    case 1: return 'lax'
    // SameSite=None requires Secure; downgrade an insecure one to lax so it is not rejected.
    case 0: return secure ? 'no_restriction' : 'lax'
    default: return 'unspecified'
  }
}

/** Does a cookie's host cover `site` (a bare hostname)? Matches host-only and domain cookies. */
export function hostMatches(cookieHost: string, site: string): boolean {
  const bare = cookieHost.replace(/^\./, '').toLowerCase()
  const want = site.replace(/^\./, '').toLowerCase()
  return bare === want || want.endsWith(`.${bare}`) || bare.endsWith(`.${want}`)
}

/** Copy a possibly-locked SQLite file (and its WAL) to a temp dir so a running browser can't block the read. */
function copyLocked(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rocket-cookies-'))
  const dest = join(dir, 'Cookies')
  copyFileSync(path, dest)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(path + suffix)) copyFileSync(path + suffix, dest + suffix)
  }
  return dest
}

function firefoxCookiePath(): string | null {
  for (const root of FIREFOX_ROOTS) {
    if (!existsSync(root)) continue
    const profile = firefoxDefaultProfile(root)
    if (!profile) continue
    const cookies = join(root, profile, 'cookies.sqlite')
    if (existsSync(cookies)) return cookies
  }
  return null
}

function firefoxDefaultProfile(root: string): string | null {
  const ini = join(root, 'profiles.ini')
  if (existsSync(ini)) {
    const text = readFileSync(ini, 'utf8')
    // Prefer an [Install*] Default= entry, else a [Profile*] marked Default=1.
    const install = text.match(/^Default=(.+)$/m)
    const blocks = text.split(/\[/)
    for (const block of blocks) {
      if (/^Profile/i.test(block) && /\bDefault=1\b/.test(block)) {
        const p = block.match(/^Path=(.+)$/m)
        if (p) return p[1].trim()
      }
    }
    if (install && install[1].includes('/')) return install[1].trim()
  }
  // No usable ini: fall back to a *.default* directory with a cookie store.
  try {
    const dirs = readdirSync(root).filter((d) => /\.default/i.test(d))
    for (const d of dirs) if (existsSync(join(root, d, 'cookies.sqlite'))) return d
  } catch {
    // Unreadable root.
  }
  return null
}
