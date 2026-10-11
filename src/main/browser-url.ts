// What the address field's text means, and how hidden browser views are kept out of sight.

import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

/** Default home page for new tabs and when the last tab is closed. */
export const NEW_TAB_URL = 'https://www.google.com/'
export const BROWSER_PARTITION = 'persist:browser'
/** Behind pages before they paint; matches `.browser-stage` in the renderer. */
export const PAGE_BACKGROUND = '#141518'

/** A tab with no real page yet (empty address field, title "New Tab"). */
export function isBlankTabUrl(url: string): boolean {
  return !url || url === 'about:blank'
}

/** Home or blank tabs: omit from reopen-closed and browsing history. */
export function isNewTabUrl(url: string): boolean {
  // Google's home page may come back with tracking parameters added; a search has a path.
  return isBlankTabUrl(url) || url.replace(/[?#].*$/, '') === NEW_TAB_URL
}

/** Whether typed text is an address rather than words to search for. */
export function isAddress(input: string): boolean {
  const text = input.trim()
  if (/^(https?|file|about):/i.test(text)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return true
  return !/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)
}

/** A typed address or a search: bare words go to a search engine, hosts get a scheme. */
export function toUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^(https?|file|about):/i.test(text)) return text
  if (!isAddress(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`
  return /^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(text) ? `http://${text}` : `https://${text}`
}

/** An address as people read it: no scheme, no www, no trailing slash. */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
}

// A browser view is a native surface: it cannot be covered, only hidden or moved. There are two
// ways to take one off screen:
// - 'invisible', the default, uses setVisible(false). Chromium then treats the page as a
//   background tab and stops drawing it: an animating page goes from 60 frames a second to none.
// - 'park' moves it almost entirely outside the window, with one pixel left inside so Chromium
//   keeps the surface mapped. The page does not know it is hidden and keeps rendering. The
//   reference build used this because it saw views stay blank after setVisible(false); that has
//   not shown on Electron 44, and CRAFT_BROWSER_HIDE=park brings it back if it ever does.
// Either way a view is added to the window once and never removed and re-added.
const INVISIBLE = process.env.CRAFT_BROWSER_HIDE !== 'park'

export function conceal(window: BrowserWindow, view: WebContentsView): void {
  if (INVISIBLE) {
    view.setVisible(false)
    return
  }
  const [width, height] = window.getContentSize()
  const size = view.getBounds()
  view.setBounds({ x: width - 1, y: height - 1, width: size.width, height: size.height })
}

export function reveal(view: WebContentsView, bounds: Rectangle): void {
  view.setBounds(bounds)
  if (INVISIBLE) view.setVisible(true)
}

/** The languages pages are told the user reads. Electron's default repeats "en". */
export const ACCEPT_LANGUAGES = 'en-US,en'

/**
 * A session's user agent with the app's and Electron's names taken out. Electron's default is
 * Chrome's with `<app>/<version>` and `Electron/<version>` added, and login pages read those as a
 * bot. The Chrome version is kept as it is, so it stays true across Electron upgrades.
 */
export function plainUserAgent(userAgent: string, appName: string): string {
  // Electron drops the spaces from a product name in the token ("Craft Studio" gives
  // `CraftStudio/0.1.0`, seen with Electron 44.5.1 on 2026-10-11), so a space matches either way.
  const name = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, ' ?')
  return userAgent.replace(new RegExp(` (?:${name}|Electron)/\\S+`, 'g'), '')
}

// ── User-Agent Client Hints ─────────────────────────────────────────────

export type UserAgentBrand = { brand: string; version: string }

/** The `Emulation.UserAgentMetadata` the DevTools protocol takes, as Chrome would fill it. */
export type UserAgentMetadata = {
  brands: UserAgentBrand[]
  fullVersionList: UserAgentBrand[]
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  mobile: boolean
  wow64: boolean
}

// Chrome's own algorithm, from components/embedder_support/user_agent_utils.cc (Chromium main,
// read 2026-10-06). The GREASE brand's text and version, and the order of the whole list, are all
// derived from the major version, so for a given Chrome build the result is exactly what that
// Chrome sends. ShuffleBrandList places list[i] at position order[i].
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
const GREASE_VERSIONS = ['8', '99', '24']
const ORDERS_OF_THREE = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]

function brandList(seed: number, version: string, full: boolean): UserAgentBrand[] {
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length]
  const grease: UserAgentBrand = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion
  }
  // A Chromium-branded build sends only the first two; this browser presents as Google Chrome, as
  // its user agent already does, so the product brand is included as Chrome's own builds have it.
  const list: UserAgentBrand[] = [grease, { brand: 'Chromium', version }, { brand: 'Google Chrome', version }]
  const order = ORDERS_OF_THREE[seed % ORDERS_OF_THREE.length]
  const shuffled: UserAgentBrand[] = new Array(list.length)
  list.forEach((entry, i) => { shuffled[order[i]] = entry })
  return shuffled
}

/**
 * The client hints a real Chrome of the user agent's version sends on Linux. `session.setUserAgent`
 * replaces only the string; Chromium's hint metadata stays empty, so a page would see a browser
 * claiming Chrome that sends no Sec-CH-UA headers and has a null navigator.userAgentData. Only the
 * DevTools protocol can set both together (browser-pane.ts). On Linux Chrome's platformVersion is
 * the empty string, model is empty and wow64 false. Null for a user agent that is not Chrome on
 * Linux, which this app never produces.
 */
export function userAgentMetadata(userAgent: string): UserAgentMetadata | null {
  const chrome = /Chrome\/(\d+)\.(\d+\.\d+\.\d+)/.exec(userAgent)
  if (!chrome || !/\bLinux\b/.test(userAgent)) return null
  const major = chrome[1]
  const seed = Number(major)
  const arm = /\b(aarch64|arm64)\b/.test(userAgent)
  return {
    brands: brandList(seed, major, false),
    fullVersionList: brandList(seed, `${major}.${chrome[2]}`, true),
    platform: 'Linux',
    platformVersion: '',
    architecture: arm ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false
  }
}

// Electron has no client-hints delegate (ElectronBrowserContext::GetClientHintsControllerDelegate
// returns null, Electron 44), so Chromium never puts the Sec-CH-UA headers on a request, whatever
// the metadata says; the pane adds them itself from the same metadata (browser-pane.ts). Chrome
// sends the three low-entropy hints on every secure request and the rest only to an origin that
// asked for them with Accept-CH (https://wicg.github.io/ua-client-hints/, read 2026-10-06).

const LOW_ENTROPY = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']

/** Structured-header serialization of a brand list, as Chrome writes it. */
function brandHeader(brands: UserAgentBrand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
}

/** The hint names an Accept-CH response header asks for, lower-cased; unknown names are kept. */
export function parseAcceptCh(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(',') : value ?? ''
  return text.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('sec-ch-ua'))
}

/**
 * The Sec-CH-UA request headers for one request: always the low-entropy three, plus whichever
 * high-entropy ones the origin has asked for. Header names are in Chrome's casing.
 */
export function clientHintHeaders(meta: UserAgentMetadata, requested: Iterable<string> = []): Record<string, string> {
  const all: Record<string, string> = {
    'sec-ch-ua': brandHeader(meta.brands),
    'sec-ch-ua-mobile': meta.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${meta.platform}"`,
    'sec-ch-ua-platform-version': `"${meta.platformVersion}"`,
    'sec-ch-ua-arch': `"${meta.architecture}"`,
    'sec-ch-ua-bitness': `"${meta.bitness}"`,
    'sec-ch-ua-model': `"${meta.model}"`,
    'sec-ch-ua-full-version-list': brandHeader(meta.fullVersionList),
    'sec-ch-ua-wow64': meta.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': meta.mobile ? '"Mobile"' : '"Desktop"'
  }
  const names = new Set(LOW_ENTROPY)
  for (const name of requested) if (name in all) names.add(name)
  const out: Record<string, string> = {}
  for (const name of names) out[CASED[name] ?? name] = all[name]
  return out
}

const CASED: Record<string, string> = {
  'sec-ch-ua': 'Sec-CH-UA',
  'sec-ch-ua-mobile': 'Sec-CH-UA-Mobile',
  'sec-ch-ua-platform': 'Sec-CH-UA-Platform',
  'sec-ch-ua-platform-version': 'Sec-CH-UA-Platform-Version',
  'sec-ch-ua-arch': 'Sec-CH-UA-Arch',
  'sec-ch-ua-bitness': 'Sec-CH-UA-Bitness',
  'sec-ch-ua-model': 'Sec-CH-UA-Model',
  'sec-ch-ua-full-version-list': 'Sec-CH-UA-Full-Version-List',
  'sec-ch-ua-wow64': 'Sec-CH-UA-WoW64',
  'sec-ch-ua-form-factors': 'Sec-CH-UA-Form-Factors'
}
