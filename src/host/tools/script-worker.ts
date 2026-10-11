import { parentPort, workerData } from 'node:worker_threads'

// One browser_run script, in a thread of its own so that a script that never yields can be
// stopped without taking the agent host with it. The script sees `tab`, `browser` and `sleep`;
// every method is a message to the host thread, which passes it on to the browser in main.

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
type Op = Record<string, unknown> & { op: string }

const port = parentPort!
const { code, tab: startTab } = workerData as { code: string; tab: string | null }

let seq = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
port.on('message', (reply: Reply) => {
  const waiting = pending.get(reply.id)
  if (!waiting) return
  pending.delete(reply.id)
  if (reply.ok) waiting.resolve(reply.result)
  else waiting.reject(new Error(reply.error))
})

function call(op: Op): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    port.postMessage({ type: 'call', id, op })
  })
}

/** A function to run in the page, as the expression that calls it there. */
function inPage(fn: unknown, arg?: unknown): string {
  return typeof fn === 'function' ? `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn)
}

function makeTab(tab: string | null): Record<string, unknown> {
  return {
    id: tab,
    info: () => call({ op: 'info', tab }),
    close: () => call({ op: 'close', tab }),
    goto: (url: string, options: { until?: string; untilValue?: string; timeout?: number } = {}) => call({
      op: 'goto', tab, url: String(url),
      until: options.until ?? null,
      untilValue: options.untilValue ?? null,
      settleTimeout: options.timeout ?? null
    }),
    read: (options: { focus?: string; selector?: string; query?: string; max?: number } | string = {}) => {
      const { focus, selector, query, max } = typeof options === 'string' ? { focus: options, selector: undefined, query: undefined, max: undefined } : options
      return call({ op: 'read', tab, url: null, focus: focus ?? 'all', selector: selector ?? null, query: query ?? null, max: max ?? null })
    },
    follow: (href: string, options: { until?: string; untilValue?: string; timeout?: number } = {}) => call({
      op: 'follow', tab, href: String(href),
      until: options.until ?? null,
      untilValue: options.untilValue ?? null,
      settleTimeout: options.timeout ?? null
    }),
    eval: (fn: unknown, arg?: unknown) => call({ op: 'eval', tab, expression: inPage(fn, arg) }),
    click: (target: string) => call({ op: 'click', tab, target: String(target) }),
    fill: (target: string, value: unknown) => call({ op: 'fill', tab, target: String(target), value: String(value ?? '') }),
    press: (key: string) => call({ op: 'press', tab, key: String(key) }),
    type: (text: unknown) => call({ op: 'type', tab, text: String(text) }),
    waitForNavigation: (options: { timeout?: number } = {}) => call({ op: 'waitSpa', tab, timeout: options.timeout ?? 5_000 }),
    waitFor: (what: unknown, options: { timeout?: number } = {}) => call({
      op: 'wait', tab,
      target: typeof what === 'string' ? what : null,
      expression: typeof what === 'string' ? null : inPage(what),
      timeout: options.timeout ?? 10_000
    }),
    requests: (match?: string) => call({ op: 'requests', tab, match: match ?? null }),
    body: (request: string | { id: string }) => call({ op: 'body', tab, request: typeof request === 'string' ? request : request.id }),
    screenshot: (options: { som?: boolean; max?: number } = {}) => call({
      op: 'screenshot', tab,
      som: options.som ?? null,
      somMax: options.max ?? null
    }),
    exportHar: (options: { sinceRequest?: number; saveTo?: string } = {}) => call({
      op: 'har', tab,
      sinceSeq: options.sinceRequest ?? null,
      saveTo: options.saveTo ?? null
    })
  }
}

const browser = {
  tabs: () => call({ op: 'tabs' }),
  tab: (id: string) => makeTab(String(id)),
  open: async (url?: string) => makeTab((await call({ op: 'open', url: url ?? null }) as { id: string }).id),
  fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const response = await call({
      op: 'fetch', url: String(url), method: init.method ?? null, headers: init.headers ?? null,
      body: init.body === undefined || init.body === null ? null : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    }) as { status: number; body: unknown }
    // `body` is the text, as written; json() and text() are there for a script written like fetch.
    return { ...response, ok: response.status >= 200 && response.status < 300, json: () => JSON.parse(String(response.body)), text: () => response.body }
  }
}

const show = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
const log = (...values: unknown[]): void => port.postMessage({ type: 'log', line: values.map(show).join(' ') })
const scriptConsole = { log, info: log, warn: log, error: log, debug: log }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
const NAMES = ['tab', 'browser', 'sleep', 'console']

try {
  let run: (...args: unknown[]) => Promise<unknown>
  try {
    // A script that is one expression needs no `return`.
    run = new AsyncFunction(...NAMES, `return (\n${code}\n)`)
  } catch {
    run = new AsyncFunction(...NAMES, code)
  }
  const value = await run(makeTab(startTab), browser, sleep, scriptConsole)
  // What cannot cross to the host as data (a function, a tab object) is left out, as JSON would.
  port.postMessage({ type: 'done', ok: true, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value) ?? 'null') })
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error))
  // The function's own first line is the wrapper's third.
  const at = /<anonymous>:(\d+):(\d+)/.exec(failure.stack ?? '')
  const where = at && failure.name !== 'SyntaxError' ? ` (script line ${Math.max(1, Number(at[1]) - 2)})` : ''
  port.postMessage({ type: 'done', ok: false, error: `${failure.name === 'Error' ? '' : `${failure.name}: `}${failure.message}${where}` })
}
