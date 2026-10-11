// Provider tools sometimes return failures as successful text. Keep these out of citations
// without mistaking an article that discusses HTTP errors or CAPTCHAs for a blocked page.
export function webReadProblem(text: string): string | null {
  const head = text.trim().slice(0, 1200)
  if (!head) return 'The reader returned no content.'
  if (/^(?:#\s*)?(?:Just a moment|Access denied|Attention Required|403 Forbidden|404 Not Found|Too Many Requests|Verify (?:you are|that you are) human)/i.test(head)
    || /^The server returned HTTP [45]\d\d/i.test(head)
    || /^(?:Error: )?(?:HTTP [45]\d\d|Failed to fetch|fetch failed|net::ERR_)/i.test(head)) return 'The destination returned an access challenge or HTTP failure.'
  if (/raw PDF file dump|compressed binary streams|\[Binary content \(application\/pdf/i.test(text)
    || /^%PDF-/.test(head)) return 'A PDF was downloaded but its text was not extracted. Use web_read with its saved path or URL.'
  if (/^# [^\n]*\n[\s\S]{0,500}\b(?:ERR_[A-Z_]+|Navigation failed)\b/.test(head)) return 'Browser navigation failed.'
  return null
}

export function isSearchUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com)$/.test(u.hostname)
      && (u.pathname === '/search' || u.searchParams.has('q'))
  } catch { return false }
}
