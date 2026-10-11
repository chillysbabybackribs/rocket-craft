import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AgentTab, BrowserAgentOp, BrowserDownload, ProviderId, ReadFocus } from '../../shared/types.ts'
import { isSearchUrl, webReadProblem } from '../../shared/web-evidence.ts'
import { researchTools, RESEARCH_GUIDE } from './research.ts'
import { messageOf, stringOf } from '../json.ts'
import { failureResult, textResult, type Tool, type ToolContent, type ToolResult } from './registry.ts'

// The browser tools: four of them. `browser_read` turns a page into text a model can act on;
// `browser_run` runs a script the model writes, so a whole task (go, act, wait, extract) is one
// call rather than one call per click; `browser_screenshot` shows a tab as an image;
// `browser_download` saves a file without the save dialog a model cannot answer. The pages live in Electron's main process, so everything
// here ends as requests to main (shared/types.ts, BrowserAgentOp).
//
// Which tabs exist is not a tool: it rides at the head of the user's message (`browserContext`),
// so a model starts a turn already knowing what is open.

/** The way to main's browser. */
export type BrowserLink = { request: (op: BrowserAgentOp) => Promise<unknown> }

const RUN_SECONDS = { default: 30, max: 120 }
const DOWNLOAD_SECONDS = { default: 120, max: 600 }
/** A result longer than this goes to a file, and the model is told where. */
const RESULT_LIMIT = 12_000
const RESULT_PREVIEW = 1_500
const FOCUSES: ReadFocus[] = ['all', 'text', 'elements', 'network', 'a11y']

const here = import.meta.dirname
/** Built, the worker sits beside the host's bundle; under plain Node it is the source file. */
const WORKER = [join(here, 'script-worker.js'), join(here, '..', 'script-worker.js')].find(existsSync) ?? join(here, 'script-worker.ts')

/**
 * Part of browser_read's description, which every session has from its start, so it is not also
 * sent ahead of a message: a second copy would sit in each session's history for nothing.
 */
export const BROWSER_RESEARCH_GUIDE = RESEARCH_GUIDE

const READ_DESCRIPTION = `Read a web page in Craft Studio's built-in browser, where the user is signed in to their sites. Returns a header (title, hash, route hint), page text with links, controls with refs (e12) for browser_run, and recent data requests.
${BROWSER_RESEARCH_GUIDE}
Decision tree: (1) browser_read or tab.read — default observe; recent JSON record APIs may be attached inline (truncated). (2) Full URL from read (including #…) or tab.goto/tab.follow. (3) browser.fetch when you only need JSON. (4) tab.waitFor, tab.goto(..., { until }), or start tab.waitForNavigation() before a hash/pushState click. (5) tab.click/fill only when data cannot replace UI. browser_run appends network/page deltas since the script started.
Pass url to open a source or search page. Search pages only supply leads. Use your own tab (never the user's; Craft Studio switches the view to it). Pass tab (an id such as t3 from the tab list) to read a tab that is already open. Pass neither to read your tab again.
Use this rather than fetching a URL yourself when a page needs the user's login or JavaScript to show its content. Stale refs after a big re-render: read again; one automatic retry may heal a single matching control.`

const RUN_DESCRIPTION = `Run a script in Craft Studio's built-in browser. One script should do a whole task on a destination page: act, wait, extract, and return the result. Native search and web_search are starting points; browser search is allowed for recovery. Do as much per call as you can.
The script is the body of an async function. It has:
- tab: your tab, or the one named by the tab argument. tab.screenshot({ som: true }) adds Set-of-Marks badges on the saved image (not on the live page); tab.exportHar({ saveTo }) writes a debug HAR of requests since script mark (or page load). tab.goto(url) waits for document ready; tab.goto(url, { until: 'hash' | 'title' | 'request', untilValue, timeout }) optionally waits for the hash, a title substring, or a GET URL fragment with status 200 (cap ~5s) — use on hash CRM/SPA routes instead of extra sleep. tab.follow(href) resolves a link from the current page (hash or relative) and goes there with hash settle when the URL has a fragment. tab.read({focus, selector, query, max}) matches browser_read — focus a11y for an accessibility snapshot with refs; query filters lines (text or /regex/). tab.eval(fn, arg); tab.click(target); tab.fill(target, value); tab.press('Enter') or 'Control+a'; tab.type(text); tab.waitFor(target or fn, {timeout}); tab.requests(match); tab.body(requestId); tab.info(); tab.screenshot(); tab.close().
- browser: browser.open(url); browser.tab(id); browser.tabs(); browser.fetch(url, {method, headers, body}) — session cookies, no CORS, {status, body} with json().
- sleep(ms), console.log.
A target is a ref from browser_read (e12), text=Visible label, or a CSS selector. Clicks scroll into view only when needed.
Prefer data to UI: when read lists a JSON endpoint (typical on Espo-style CRMs), use browser.fetch or in-page fetch before clicking lists.
A large result is saved to a file and its path returned.`

const DOWNLOAD_DESCRIPTION = `Save a file from Craft Studio's built-in browser to disk, with the user's sign-ins and no save dialog. Give url (a direct file address, absolute or relative to the tab's page) or click (a ref from browser_read, text=Label or a CSS selector for a download button). Waits for the file and returns its path, size and type.
Use this whenever you need a file from the web: never click through a save or file dialog, and do not ask the user to download for you. A click in browser_run that starts a download is also saved without a dialog, and its result lists the file.
Files go to the user's Downloads folder unless saveTo names a folder or a file (relative to the chat's working folder). Existing files are never overwritten.`

const SHOT_DESCRIPTION = `See a tab of Craft Studio's built-in browser as an image. For what text cannot tell you: layout, charts, images, canvas apps, or checking how a page looks. To read a page or find its controls, use browser_read, which is faster and exact.
Pass tab (an id such as t2 from the tab list) for a tab that is already open; without it, your own tab is captured (Craft Studio switches the view to it). Pass som: true to add ref badges (e1, e2, …) on the saved image for vision models — the live page is not modified.`

/**
 * `cwdOf` gives a chat's working folder, which a relative saveTo is taken from. `onOpen` hears
 * pages whose content was read successfully, so navigation and downloads alone do not
 * become citation evidence.
 */
export function browserTools(
  link: BrowserLink, resultsDir: string, cwdOf: (chatId: string | null) => string | null = () => null, onOpen: (chatId: string | null, url: string) => void = () => {}
): Tool[] {
  const request = async (op: BrowserAgentOp, chatId: string | null): Promise<unknown> => {
    const result = await link.request(op)
    if (op.op === 'read') {
      const text = String(result)
      const problem = webReadProblem(text)
      if (problem) throw new Error(problem)
      // The header contains the actual URL even when the caller only supplied a tab ID.
      const actual = text.match(/^(https?:\/\/\S+)\s+·\s+tab /m)?.[1] || op.url
      if (actual && !isSearchUrl(actual) && text.trim() && op.focus !== 'network' && op.focus !== 'elements') onOpen(chatId, actual)
    } else if (op.op === 'fetch' && result && typeof result === 'object') {
      const fetched = result as { status?: number; body?: unknown }
      if (fetched.status && fetched.status >= 200 && fetched.status < 300 && typeof fetched.body === 'string'
        && !webReadProblem(fetched.body) && !isSearchUrl(op.url)) onOpen(chatId, op.url)
    }
    return result
  }
  return [
    ...researchTools(link, resultsDir, cwdOf, onOpen),
    {
      name: 'browser_read',
      description: READ_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Go here first.' },
          tab: { type: 'string', description: 'A tab id such as t3. Default: your own tab.' },
          focus: { type: 'string', enum: FOCUSES, description: 'all (default): text, controls and data requests, each kept short. text: more of the text. elements: every link and control. a11y: accessibility tree with refs (CDP). network: every request.' },
          selector: { type: 'string', description: 'Read only inside this element: a CSS selector, a ref, or text=…' },
          query: { type: 'string', description: 'Find-in-page: keep lines matching this text, or /regex/flags.' },
          max: { type: 'number', description: 'Most characters of text (or most elements, a11y refs, or requests) to return.' }
        },
        additionalProperties: false
      },
      run: async (args, context) => {
        try {
          return textResult(String(await request({
        op: 'read',
        chat: context.chatId,
        tab: stringOf(args.tab) || null,
        url: stringOf(args.url) || null,
        focus: FOCUSES.find((focus) => focus === args.focus) ?? 'all',
        selector: stringOf(args.selector) || null,
        query: stringOf(args.query) || null,
        max: typeof args.max === 'number' && args.max > 0 ? Math.round(args.max) : null
          }, context.chatId)))
        } catch (error) {
          return failureResult('PAGE_UNREADABLE', `${messageOf(error)} Use web_read or another primary source.`, 'operation')
        }
      }
    },
    {
      name: 'browser_run',
      description: RUN_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The script: the body of an async function. Return the result.' },
          tab: { type: 'string', description: 'The tab `tab` starts as, such as t3. Default: your own tab.' },
          timeout: { type: 'number', description: `Seconds before the script is stopped. Default ${RUN_SECONDS.default}, at most ${RUN_SECONDS.max}.` }
        },
        required: ['code'],
        additionalProperties: false
      },
      run: (args, context) => runScript(
        { request: (op) => request(op, context.chatId) },
        resultsDir,
        cwdOf(context.chatId),
        {
          code: stringOf(args.code),
          tab: stringOf(args.tab) || null,
          chat: context.chatId,
          seconds: Math.min(Math.max(typeof args.timeout === 'number' ? args.timeout : RUN_SECONDS.default, 1), RUN_SECONDS.max)
        }
      )
    },
    {
      name: 'browser_download',
      description: DOWNLOAD_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The file to save: a full URL, or one relative to the tab\'s page.' },
          click: { type: 'string', description: 'Instead of url: what to click to start the download (a ref such as e12, text=Download, or a CSS selector).' },
          tab: { type: 'string', description: 'A tab id such as t3. Default: your own tab.' },
          saveTo: { type: 'string', description: 'A folder, or a file path to save as. Relative paths start in the chat\'s working folder. Default: the user\'s Downloads folder.' },
          timeout: { type: 'number', description: `Seconds to wait for the file to finish. Default ${DOWNLOAD_SECONDS.default}, at most ${DOWNLOAD_SECONDS.max}.` }
        },
        additionalProperties: false
      },
      run: async (args, context) => {
        const url = stringOf(args.url).trim() || null
        const click = stringOf(args.click).trim() || null
        if (!url === !click) return { ...textResult('Give either url or click: the file\'s address, or what to click to start its download.'), isError: true }
        const seconds = Math.min(Math.max(typeof args.timeout === 'number' ? args.timeout : DOWNLOAD_SECONDS.default, 1), DOWNLOAD_SECONDS.max)
        const download = await request({
          op: 'download', chat: context.chatId, tab: stringOf(args.tab) || null, url, target: click,
          saveTo: savePath(stringOf(args.saveTo).trim(), cwdOf(context.chatId)), timeout: seconds * 1_000
        }, context.chatId) as BrowserDownload
        return { ...textResult(describeDownload(download, seconds)), isError: download.state === 'cancelled' || download.state === 'interrupted' }
      }
    },
    {
      name: 'browser_screenshot',
      description: SHOT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', description: 'A tab id such as t2. Default: your own tab.' },
          som: { type: 'boolean', description: 'Overlay Set-of-Marks ref badges on visible controls before capture.' },
          somMax: { type: 'number', description: 'Most controls to badge when som is true (default 40).' }
        },
        additionalProperties: false
      },
      run: async (args, context) => screenshotResult(await link.request({
        op: 'screenshot',
        chat: context.chatId,
        tab: stringOf(args.tab) || null,
        som: args.som === true ? true : null,
        somMax: typeof args.somMax === 'number' && args.somMax > 0 ? Math.round(args.somMax) : null
      }))
    }
  ]
}

/** A saveTo as main needs it: absolute, with ~ and relative paths resolved; empty means the default. */
export function savePath(saveTo: string, cwd: string | null): string | null {
  if (!saveTo) return null
  const slash = /[\\/]$/.test(saveTo) ? '/' : ''
  // join and resolve drop a trailing slash, which is how a model says "this folder", so it is put back.
  if (saveTo === '~' || saveTo.startsWith('~/')) return join(homedir(), saveTo.slice(2)).replace(/\/$/, '') + slash
  if (isAbsolute(saveTo)) return saveTo
  return resolve(cwd ?? homedir(), saveTo) + slash
}

function bytes(count: number): string {
  return count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KB` : `${(count / 1024 / 1024).toFixed(1)} MB`
}

export function describeDownload(download: BrowserDownload, seconds: number): string {
  const type = download.mime ? `, ${download.mime}` : ''
  if (download.state === 'completed') return `Downloaded ${download.name} (${bytes(download.size)}${type}) to ${download.path}`
  if (download.state === 'progressing') {
    const share = download.size ? ` (${Math.round((download.received / download.size) * 100)}% of ${bytes(download.size)})` : ''
    return `Still downloading after ${seconds}s: ${bytes(download.received)} so far${share}. It will be at ${download.path} when done; check with browser_run's downloads list or wait longer next time.`
  }
  return `The download of ${download.url} was ${download.state} after ${bytes(download.received)}. Nothing complete is at ${download.path}; try again, or read the page for another link.`
}

function screenshotResult(raw: unknown): ToolResult {
  const shot = raw as { base64?: string; mimeType?: string; id?: string; title?: string; url?: string }
  if (!shot.base64) return { ...textResult('The screenshot could not be taken.'), isError: true }
  const label = shot.id ? `${shot.id}: ${shot.title || '(untitled)'} · ${shot.url || '(blank)'}` : 'browser tab'
  const content: ToolContent[] = [
    { type: 'text', text: `Screenshot of ${label}.` },
    { type: 'image', data: shot.base64, mimeType: shot.mimeType ?? 'image/png' }
  ]
  return { content }
}

type WorkerMessage =
  | { type: 'call'; id: number; op: Record<string, unknown> & { op: string } }
  | { type: 'log'; line: string }
  | { type: 'done'; ok: true; value: unknown }
  | { type: 'done'; ok: false; error: string }

async function runScript(
  link: BrowserLink, resultsDir: string, cwd: string | null, run: { code: string; tab: string | null; chat: string | null; seconds: number }
): Promise<ToolResult> {
  if (!run.code.trim()) return { ...textResult('There is no script to run.'), isError: true }
  const logs: string[] = []
  const started = Date.now()
  let touchedTab = false
  let summarizeTab = false
  let marked = false
  const worker = new Worker(WORKER, { workerData: { code: run.code, tab: run.tab } })
  const outcome = await new Promise<{ ok: true; value: unknown } | { ok: false; error: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `The script was stopped after ${run.seconds}s. Do less per call, or pass a longer timeout.` }), run.seconds * 1_000)
    const settle = (result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      clearTimeout(timer)
      resolve(result)
    }
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'log') logs.push(message.line)
      else if (message.type === 'done') settle(message)
      else {
        const forTab = 'tab' in message.op
        // Closing tabs is bookkeeping, not page inspection. Marking or summarizing a close
        // would load a restored tab or create a replacement agent tab after closing them all.
        if (message.op.op === 'close') summarizeTab = false
        else if (forTab || message.op.op === 'open') touchedTab = summarizeTab = true
        // The worker names tabs; which chat is asking is added here.
        const op = { ...message.op, ...(forTab || message.op.op === 'open' ? { chat: run.chat } : {}) } as BrowserAgentOp
        if (op.op === 'har' && op.saveTo) op.saveTo = savePath(op.saveTo, cwd) ?? op.saveTo
        const runOp = async (): Promise<void> => {
          if (message.op.op !== 'close' && (forTab || message.op.op === 'open') && !marked) {
            marked = true
            const tab = 'tab' in op ? op.tab : run.tab
            await link.request({ op: 'mark', chat: run.chat, tab: tab ?? run.tab }).catch(() => null)
          }
          return link.request(op).then(
          // A script has no use for image bytes; it gets a file it can name in what it returns.
          (result) => {
            if (op.op === 'screenshot') {
              const shot = result as { som?: boolean; markers?: number }
              worker.postMessage({
                id: message.id, ok: true,
                result: { ...saveShot(result, resultsDir, run.chat), ...(shot.som ? { som: true, markers: shot.markers ?? 0 } : {}) }
              })
              return
            }
            worker.postMessage({ id: message.id, ok: true, result })
          },
          (error: unknown) => worker.postMessage({ id: message.id, ok: false, error: messageOf(error) })
          )
        }
        void runOp()
      }
    })
    worker.on('error', (error) => settle({ ok: false, error: messageOf(error) }))
    worker.on('exit', () => settle({ ok: false, error: 'The script ended without a result.' }))
  })
  void worker.terminate()

  const parts: string[] = []
  if (logs.length) parts.push(logs.join('\n'))
  if (!outcome.ok) parts.push(`Error: ${outcome.error}`)
  else if (outcome.value !== undefined) parts.push(typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value))
  else if (!logs.length) parts.push('(The script returned nothing.)')
  let text = parts.join('\n')
  if (text.length > RESULT_LIMIT) text = spill(text, resultsDir, run.chat, outcome.ok && typeof outcome.value !== 'string' && !logs.length)
  // Files a click in the script downloaded, saved without a dialog: the model is told where.
  if (touchedTab) {
    const files = await link.request({ op: 'downloads', chat: run.chat, since: started }).catch(() => []) as BrowserDownload[]
    for (const file of files) text += `\n[download: ${describeDownload(file, Math.round((Date.now() - started) / 1000))}]`
  }
  // Where the script left the tab, so the next step does not need a call to find out.
  if (summarizeTab) {
    const where = await link.request({ op: 'info', chat: run.chat, tab: run.tab }).catch(() => null) as Pick<AgentTab, 'id' | 'url' | 'title'> | null
    if (where) text += `\n\n[tab ${where.id}: ${where.title || '(untitled)'} · ${where.url || '(blank)'}]`
    const delta = await link.request({ op: 'delta', chat: run.chat, tab: run.tab }).catch(() => null)
    if (typeof delta === 'string' && delta.trim()) text += `\n\n${delta}`
  }
  return { ...textResult(text), isError: !outcome.ok }
}

function saveShot(raw: unknown, resultsDir: string, chat: string | null): { path: string } {
  const shot = raw as { base64: string }
  const dir = join(resultsDir, chat ?? 'shared')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`)
  writeFileSync(path, Buffer.from(shot.base64, 'base64'))
  return { path }
}

/** Put an oversized result in a file and return the start of it with the path. */
function spill(text: string, resultsDir: string, chat: string | null, json: boolean): string {
  try {
    const dir = join(resultsDir, chat ?? 'shared')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.${json ? 'json' : 'txt'}`)
    writeFileSync(file, text)
    return `${text.slice(0, RESULT_PREVIEW)}\n[… the full result is ${text.length} characters, saved to ${file}]`
  } catch {
    return `${text.slice(0, RESULT_LIMIT)}\n[… cut at ${RESULT_LIMIT} of ${text.length} characters; return less]`
  }
}

/**
 * The open tabs for the head of a user's message. Null when they have not changed since this
 * provider session was last told. A `fresh` session has been told nothing yet.
 */
export function browserContext(link: BrowserLink): (chatId: string, provider: ProviderId, fresh: boolean) => Promise<string | null> {
  const toldTabs = new Map<string, string>()
  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  return async (chatId, provider, fresh) => {
    const key = `${chatId}:${provider}`
    // A turn never waits on this: a browser that is slow to answer is simply not described.
    const tabs = await Promise.race([
      link.request({ op: 'tabs' }).catch(() => null) as Promise<AgentTab[] | null>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))
    ])
    const open = (tabs ?? []).filter((tab) => tab.url).slice(0, 12)
    const lines = open.map((tab) => `${tab.active ? '*' : '-'} ${tab.id}${tab.agent ? ' (yours)' : ''}  ${clip(tab.title || '(untitled)', 60)}  ${clip(tab.url, 140)}`).join('\n')
    if (!lines || (!fresh && toldTabs.get(key) === lines)) return null
    toldTabs.set(key, lines)
    return `<browser>\nTabs open in Craft Studio's built-in browser (* is the one the user is looking at):\n${lines}\n</browser>`
  }
}
