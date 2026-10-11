import type { BrowserAgentOp, TurnSources } from './types.ts'

// What a reply cites against what its turn opened. The host records both when a turn ends and
// the window marks each link in the reply with the result. The rules are deliberately dumb: a
// page counts as opened only when a reader reports usable content, two URLs are the same page
// only by host and path, and a search result is never a source. Nothing here asks a model.

/** A URL as one page: host without `www.`, path without a trailing slash, query without tracking parameters. Null for anything but HTTP(S). */
export function pageKey(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/+$/, '')
  const params = [...parsed.searchParams].filter(([name]) => !/^utm_/i.test(name))
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : ''
  return `${host}${path}${query}`
}

/** Every HTTP(S) URL in markdown text, each once, in order: link targets and bare URLs. */
export function urlsIn(text: string): string[] {
  const found = new Set<string>()
  // Link targets first, so a bare match never cuts one short at a parenthesis in its path.
  for (const match of text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) found.add(match[1]!)
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]]+/g)) found.add(match[0].replace(/[.,;:!?'"]+$/, ''))
  return [...found]
}

/** The page a browser request is for, or null when it opens none. A `read` with no url reads the tab as it is. */
export function openedUrl(op: BrowserAgentOp): string | null {
  switch (op.op) {
    case 'open': case 'goto': case 'read': case 'fetch': case 'download': return op.url || null
    case 'follow': return /^https?:\/\//i.test(op.href) ? op.href : null
    default: return null
  }
}

/** The turn's record: what it opened, each page once, and each cited page marked opened or not. Null when there is nothing to record. */
export function turnSources(opened: TurnSources['opened'], replies: string[]): TurnSources | null {
  const keys = new Set<string>()
  const pages: TurnSources['opened'] = []
  for (const entry of opened) {
    const key = pageKey(entry.url)
    if (!key || keys.has(key)) continue
    keys.add(key)
    pages.push(entry)
  }
  const cited: TurnSources['cited'] = []
  const seen = new Set<string>()
  for (const text of replies) {
    for (const url of urlsIn(text)) {
      const key = pageKey(url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      cited.push({ url, opened: keys.has(key) })
    }
  }
  return pages.length || cited.length ? { opened: pages, cited } : null
}

/** For the window: each cited page's key → whether it was opened, so a link can carry its mark. */
export function citationMarks(sources: TurnSources | null): Record<string, boolean> | undefined {
  if (!sources?.cited.length) return undefined
  return Object.fromEntries(sources.cited.flatMap(({ url, opened }) => { const key = pageKey(url); return key ? [[key, opened]] : [] }))
}

/** What the next message in a chat is told when its last reply cited pages the turn never opened; null when it did not. */
export function sourcesNotice(sources: TurnSources | null): string | null {
  const unopened = sources?.cited.filter((entry) => !entry.opened) ?? []
  if (!unopened.length) return null
  const count = unopened.length === 1 ? 'a page' : `${unopened.length} pages`
  return `<sources>\nThe last reply in this chat cited ${count} its turn never opened: ${unopened.map((entry) => entry.url).join(', ')}. A search result is a lead, not a source. Cite only pages you opened this turn, and say a claim is not verified when you could not open its primary page.\n</sources>`
}
