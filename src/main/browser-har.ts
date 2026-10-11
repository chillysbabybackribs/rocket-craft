/** Minimal HAR 1.2 export from the tab network log, for debugging. */

export type HarRequestRow = {
  id: string
  method: string
  url: string
  kind: string
  status: number | null
  mime: string
  size: number | null
}

export type HarLog = {
  log: {
    version: '1.2'
    creator: { name: 'craft-studio'; version: '0.1' }
    entries: unknown[]
  }
}

export function buildHar(requests: HarRequestRow[], sinceSeq: number): HarLog {
  const entries = requests
    .filter((request) => Number(request.id.slice(1)) > sinceSeq)
    .map((request) => ({
      startedDateTime: new Date().toISOString(),
      time: 0,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: -1
      },
      response: {
        status: request.status ?? 0,
        statusText: request.status === 200 ? 'OK' : '',
        httpVersion: 'HTTP/1.1',
        headers: [],
        cookies: [],
        content: { size: request.size ?? 0, mimeType: request.mime || 'application/octet-stream' },
        redirectURL: '',
        headersSize: -1,
        bodySize: request.size ?? 0
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      rocket: { id: request.id, kind: request.kind }
    }))
  return {
    log: {
      version: '1.2',
      creator: { name: 'craft-studio', version: '0.1' },
      entries
    }
  }
}

export function harSummary(har: HarLog, pageUrl: string): string {
  const n = har.log.entries.length
  return `HAR export: ${n} ${n === 1 ? 'entry' : 'entries'} since mark · page ${pageUrl || '(blank)'}`
}
