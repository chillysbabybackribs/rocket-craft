import { nativeImage, session, type WebContents } from 'electron'
import type { AgentTab, BrowserAgentOp, GotoUntil } from '../shared/types.ts'
import { BrowserDownloads } from './browser-downloads.ts'
import { buildA11ySnapshot, filterReadByQuery, type AxNode } from './browser-a11y.ts'
import { formatAttachedJson } from './browser-json-attach.ts'
import { formatNetworkDelta, formatReadDelta } from './browser-run-delta.ts'
import { buildHar, harSummary, type HarRequestRow } from './browser-har.ts'
import { SPA_HOOK } from './browser-spa-hook.ts'
import { writeFileSync } from 'node:fs'
import { compositeSomMarkers, type SomMarker } from './browser-som-composite.ts'
import { PAGE_LIB, type DigestOptions } from './browser-page-lib.ts'
import type { BrowserPane, TabHandle } from './browser-pane.ts'
import { toUrl } from './browser-url.ts'

// The hands of the browser tools. The agent host asks for one thing at a time (shared/types.ts,
// BrowserAgentOp) and this does it to a tab through the DevTools protocol, which Electron lets
// the app speak to its own pages directly: no debugging port, no second browser.
//
// Every tab's debugger is attached by the pane as the tab is made, for the user-agent client-hint
// override (browser-pane.ts); attaching alone enables nothing a page can see. The domains the
// tools need are enabled the first time a tool touches a tab and stay on, so a tab only the user
// browses in is never instrumented. Reading and finding run in an isolated world
// (browser-page-lib.ts); a model's own JavaScript runs in the page's world; clicks and keys are
// real input events, which pages cannot tell from the user's.

const PARTITION = 'persist:browser'
// A page is ready to work with when its document is: the ads, trackers and embeds a heavy page
// goes on loading for many seconds are not waited for. After that comes a short grace for the
// page's own scripts to draw, cut short the moment the page finishes loading.
const READY_TIMEOUT_MS = 20_000
const GRACE_MS = 700
const SETTLE_CAP_MS = 5_000
const SHOT_WIDTH = 1280
const SHOT_QUALITY = 72
const REQUEST_LOG = 300
const FETCH_LIMIT = 5_000_000

type LoggedRequest = {
  id: string
  /** The protocol's own id, for fetching the body. */
  cdpId: string
  method: string
  url: string
  kind: string
  status: number | null
  mime: string
  size: number | null
}

type Attached = {
  /** The isolated world the page library lives in; null until made, and after a navigation. */
  world: number | null
  requests: LoggedRequest[]
  requestSeq: number
  /** The log's count when the page now showing began to load: later requests are this page's. */
  pageStart: number
  /** Dialogs the page raised since the last reading, already answered. */
  dialogs: string[]
  /** Whether the document now showing has been parsed; false from the start of a navigation. */
  ready: boolean
  /** Whether the page is kept running at full speed while hidden, as it is while a turn works in it. */
  awake: boolean
  /** browser_run: request log position at script start. */
  scriptMark: number | null
  /** browser_run: compact elements digest at script start. */
  readSnapshot: string | null
  urlAtMark: string | null
  spaHookInstalled: boolean
}

const KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' }, Tab: { code: 9 }, Escape: { code: 27 }, Backspace: { code: 8 }, Delete: { code: 46 },
  ArrowLeft: { code: 37 }, ArrowUp: { code: 38 }, ArrowRight: { code: 39 }, ArrowDown: { code: 40 },
  PageUp: { code: 33 }, PageDown: { code: 34 }, End: { code: 35 }, Home: { code: 36 }, Space: { code: 32, text: ' ' }
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class BrowserAgent {
  private readonly attached = new WeakMap<WebContents, Attached>()
  /** Tabs whose Network and Page domains this has enabled on the current debugger attachment. */
  private readonly enabled = new WeakSet<WebContents>()
  /** chat → the tab its model works in. */
  private readonly workTabs = new Map<string, string>()
  /** chat → the pages its running turn has used. */
  private readonly touched = new Map<string, Set<WebContents>>()

  private readonly downloads: BrowserDownloads

  constructor(private readonly pane: BrowserPane) {
    this.downloads = new BrowserDownloads(session.fromPartition(PARTITION), (contents) => this.ownerOf(contents))
  }

  dispose(): void {
    this.downloads.dispose()
  }


  /** The chat whose turn is working in a page (its own tab, or one it touched), or null for the user's alone. */
  private ownerOf(contents: WebContents): string | null {
    for (const [chat, used] of this.touched) if (used.has(contents)) return chat
    for (const [chat, id] of this.workTabs) if (this.pane.agentTab(id)?.contents === contents) return chat
    return null
  }

  async handle(op: BrowserAgentOp): Promise<unknown> {
    switch (op.op) {
      case 'tabs':
        return this.pane.agentTabs()
      case 'open': {
        const tab = this.pane.agentOpen()
        this.workTabs.set(op.chat ?? '', tab.id)
        if (op.url) await this.navigate(tab, op.url)
        return this.info(tab)
      }
      case 'fetch':
        return this.fetch(op)
      case 'info':
        return this.info(this.tab(op))
      case 'close': {
        const key = op.chat ?? ''
        const ref = op.tab ?? this.workTabs.get(key)
        if (!ref) return null
        await this.pane.agentClose(ref)
        for (const [chat, id] of this.workTabs) if (id === ref) this.workTabs.delete(chat)
        return null
      }
      case 'goto': {
        const tab = this.tab(op)
        const problem = await this.navigate(tab, op.url)
        if (op.until && op.until !== 'none') await this.settleAfterGoto(tab, op.url, op.until, op.untilValue ?? null, op.settleTimeout ?? null)
        return { ...this.info(tab), ...(problem ? { problem } : {}) }
      }
      case 'follow': {
        const tab = this.tab(op)
        const base = tab.contents.getURL()
        if (!base || base === 'about:blank') throw new Error('Open a page before following a link from it.')
        let full: string
        try { full = new URL(op.href, base).href } catch { throw new Error(`"${op.href}" is not a link this tab can follow.`) }
        const problem = await this.navigate(tab, full)
        const until = op.until ?? (new URL(full).hash ? 'hash' : null)
        if (until && until !== 'none') await this.settleAfterGoto(tab, full, until, op.untilValue ?? null, op.settleTimeout ?? null)
        return { ...this.info(tab), ...(problem ? { problem } : {}) }
      }
      case 'read': {
        // With nothing to go to and no tab of its own yet, a model means the page the user is on.
        const tab = this.tab(op, !op.url)
        const problem = op.url ? await this.navigate(tab, op.url) : null
        return this.read(tab, op, problem)
      }
      case 'eval':
        return await this.evaluate(this.tab(op), op.expression, false) ?? null
      case 'click':
        await this.click(this.tab(op), op.target)
        return null
      case 'download': {
        const tab = this.tab(op)
        let url: string | null = null
        if (op.url) {
          const base = /^https?:/.test(tab.contents.getURL()) ? tab.contents.getURL() : undefined
          try { url = new URL(op.url, base).href } catch { throw new Error(`"${op.url}" is not an address. Give a full URL, or one relative to the tab's page.`) }
        } else if (!op.target) throw new Error('Say what to download: a url, or a click target that starts the download.')
        const startWithin = url ? 30_000 : 15_000
        const pending = this.downloads.expect(tab.contents, op.chat ?? '', op.saveTo, url, startWithin)
        if (url) tab.contents.downloadURL(url)
        else await this.click(tab, op.target!)
        const entry = await pending
        if (!entry) {
          throw new Error(url
            ? `${url} did not start downloading within ${startWithin / 1000}s. Check the address in browser_read, or get it with browser.fetch in browser_run.`
            : `Clicking ${op.target} did not start a download within ${startWithin / 1000}s. Read the page for the real download link and pass it as url.`)
        }
        return this.downloads.settle(entry, op.timeout)
      }
      case 'downloads':
        return this.downloads.since(op.chat ?? '', op.since)
      case 'fill': {
        const tab = this.tab(op)
        const how = await this.focusTarget(tab, op.target, op.value)
        // The field's old text is selected: typing replaces it, and an empty value deletes it.
        if (how === 'typed') await (op.value ? this.send(tab, 'Input.insertText', { text: op.value }) : this.press(tab, 'Backspace'))
        return null
      }
      case 'type':
        await this.send(this.tab(op), 'Input.insertText', { text: op.text })
        return null
      case 'press': {
        const tab = this.tab(op)
        await this.press(tab, op.key)
        await this.settle(tab)
        return null
      }
      case 'wait':
        return this.wait(this.tab(op), op)
      case 'waitSpa':
        return this.waitSpa(this.tab(op), op.timeout)
      case 'mark':
        return this.mark(this.tab(op))
      case 'delta':
        return this.delta(this.tab(op))
      case 'requests': {
        const tab = this.tab(op)
        const { requests } = await this.attach(tab)
        return requests
          .filter((request) => !op.match || request.url.includes(op.match))
          .map(({ cdpId: _cdpId, ...request }) => request)
      }
      case 'body': {
        const tab = this.tab(op)
        const request = (await this.attach(tab)).requests.find((entry) => entry.id === op.request)
        if (!request) throw new Error(`There is no request ${op.request} in this tab's log.`)
        const { body, base64Encoded } = await this.send(tab, 'Network.getResponseBody', { requestId: request.cdpId }) as { body: string; base64Encoded: boolean }
        return base64Encoded ? { base64: body } : body
      }
      case 'screenshot': {
        const tab = this.tab(op)
        this.pane.agentShow(tab.id)
        await this.attach(tab)
        let somMarkers: SomMarker[] = []
        let viewportWidth = 0
        if (op.som) {
          const layout = await this.evaluate(tab, `__rocket.somMarkers(${op.somMax ?? 40})`, true) as {
            markers?: SomMarker[]
            viewportWidth?: number
          }
          somMarkers = layout?.markers ?? []
          viewportWidth = layout?.viewportWidth ?? 0
        }
        return {
          ...(await this.capture(tab, somMarkers.length ? { somMarkers, viewportWidth } : null)),
          ...this.info(tab),
          ...(op.som ? { som: true, markers: somMarkers.length } : {})
        }
      }
      case 'har': {
        const tab = this.tab(op)
        const state = await this.attach(tab)
        const since = op.sinceSeq ?? state.scriptMark ?? state.pageStart
        const rows: HarRequestRow[] = state.requests.map(({ id, method, url, kind, status, mime, size }) =>
          ({ id, method, url, kind, status, mime, size }))
        const har = buildHar(rows, since)
        if (op.saveTo) {
          writeFileSync(op.saveTo, `${JSON.stringify(har, null, 2)}\n`)
          return { path: op.saveTo, entries: har.log.entries.length, summary: harSummary(har, tab.contents.getURL()) }
        }
        return har
      }
      case 'rest':
        this.rest(op.chat)
        return null
      case 'forget': {
        this.rest(op.chat)
        const own = this.workTabs.get(op.chat)
        this.workTabs.delete(op.chat)
        if (own) this.pane.agentClose(own)
        return null
      }
    }
  }

  /**
   * What the tab's page looks like, as a JPEG no wider than a model can use. A picture goes into
   * the model's context whole, so it is kept small: a full-size PNG of a page runs to megabytes.
   */
  private async capture(
    tab: TabHandle,
    som: { somMarkers: SomMarker[]; viewportWidth: number } | null = null
  ): Promise<{ base64: string; mimeType: string }> {
    let image = await tab.contents.capturePage()
    if (image.isEmpty()) {
      // A hidden view may have no surface to copy; the protocol renders the page afresh instead.
      const shot = await this.send(tab, 'Page.captureScreenshot', { format: 'jpeg', quality: SHOT_QUALITY }) as { data: string }
      image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
    }
    if (image.isEmpty()) throw new Error(`Tab ${tab.id} has nothing drawn to capture.`)
    if (image.getSize().width > SHOT_WIDTH) image = image.resize({ width: SHOT_WIDTH, quality: 'good' })
    if (som?.somMarkers.length && som.viewportWidth > 0) {
      image = compositeSomMarkers(image, som.somMarkers, som.viewportWidth)
    }
    return { base64: image.toJPEG(SHOT_QUALITY).toString('base64'), mimeType: 'image/jpeg' }
  }

  // ── Tabs ────────────────────────────────────────────────────────────

  /** The tab an operation is for: the one it names, or the calling chat's own. */
  private tab(op: { chat: string | null; tab: string | null }, preferActive = false): TabHandle {
    const key = op.chat ?? ''
    const tab = this.resolve(key, op.tab, preferActive)
    let used = this.touched.get(key)
    if (!used) this.touched.set(key, used = new Set())
    used.add(tab.contents)
    return tab
  }

  private resolve(key: string, name: string | null, preferActive: boolean): TabHandle {
    if (name) {
      const named = this.pane.agentTab(name)
      if (!named) throw new Error(`There is no tab ${name}. Open tabs: ${this.pane.agentTabs().map((tab) => tab.id).join(', ') || 'none'}.`)
      return named
    }
    const own = this.pane.agentTab(this.workTabs.get(key) ?? '')
    if (own) return own
    const active = preferActive ? this.pane.agentActive() : null
    if (active) return active
    const opened = this.pane.agentOpen()
    this.workTabs.set(key, opened.id)
    return opened
  }

  /**
   * A turn has ended. The pages it used stop running at full speed out of sight; the next tool
   * call that touches one wakes it again. Calls that could not be tied to a chat share a key of
   * their own, which rests with every turn.
   */
  private rest(chat: string): void {
    for (const key of [chat, '']) {
      for (const contents of this.touched.get(key) ?? []) {
        const state = this.attached.get(contents)
        if (contents.isDestroyed() || !state?.awake) continue
        contents.setBackgroundThrottling(true)
        state.awake = false
      }
      this.touched.delete(key)
    }
  }

  private info(tab: TabHandle): Pick<AgentTab, 'id' | 'url' | 'title'> {
    const url = tab.contents.getURL()
    return { id: tab.id, url: url === 'about:blank' ? '' : url, title: tab.contents.getTitle() }
  }

  /** Go to an address and wait for the page's document. Returns what went wrong, if anything did. */
  private async navigate(tab: TabHandle, input: string): Promise<string | null> {
    this.pane.agentShow(tab.id)
    const url = toUrl(input)
    if (!url) throw new Error('There is no address to go to.')
    // Attached first, so the requests the page makes while loading are in the log.
    const state = await this.attach(tab)
    state.ready = false
    let problem: string | null = null
    void tab.contents.loadURL(url).catch((error: unknown) => {
      // A redirect the page makes itself aborts the first load; that is not a failure.
      const message = error instanceof Error ? error.message : String(error)
      if (!/ERR_ABORTED/.test(message)) problem = message
      state.ready = true
    })
    await this.whenReady(tab, state)
    return problem ?? (state.ready ? null : `The page had not finished parsing after ${READY_TIMEOUT_MS / 1000}s`)
  }

  /** After an action: if it started a navigation, wait for the new page's document. */
  private async settle(tab: TabHandle): Promise<void> {
    await sleep(60)
    const state = this.attached.get(tab.contents)
    if (state && !state.ready) await this.whenReady(tab, state)
  }

  private async whenReady(tab: TabHandle, state: Attached): Promise<void> {
    const gone = (): boolean => tab.contents.isDestroyed()
    for (const deadline = Date.now() + READY_TIMEOUT_MS; !state.ready && !gone() && Date.now() < deadline;) await sleep(25)
    for (const deadline = Date.now() + GRACE_MS; !gone() && tab.contents.isLoadingMainFrame() && Date.now() < deadline;) await sleep(25)
  }

  // ── The DevTools protocol ───────────────────────────────────────────

  private async attach(tab: TabHandle): Promise<Attached> {
    const { contents } = tab
    let state = this.attached.get(contents)
    // A tab a model works in is usually hidden, and a hidden page is throttled: timers slow to a
    // crawl and nothing is drawn. While a turn uses it, it keeps running at full speed out of sight.
    const wake = (attached: Attached): void => {
      if (attached.awake) return
      contents.setBackgroundThrottling(false)
      attached.awake = true
    }
    // The pane attaches every tab as it is made (browser-pane.ts), so being attached does not
    // mean this tab's domains are enabled yet; `enabled` tracks that for the current attachment.
    if (state && this.enabled.has(contents) && contents.debugger.isAttached()) {
      wake(state)
      return state
    }
    if (!contents.debugger.isAttached()) {
      try {
        contents.debugger.attach('1.3')
      } catch (error) {
        throw new Error(`Tab ${tab.id} cannot be driven right now (${error instanceof Error ? error.message : String(error)}). If its DevTools are open, close them.`)
      }
    }
    if (!state) {
      const fresh: Attached = {
        world: null, requests: [], requestSeq: 0, pageStart: 0, dialogs: [], ready: true, awake: false,
        scriptMark: null, readSnapshot: null, urlAtMark: null, spaHookInstalled: false
      }
      state = fresh
      this.attached.set(contents, fresh)
      contents.debugger.on('message', (_event, method, params) => this.onProtocol(contents, fresh, method, params as Record<string, unknown>))
      // Opening DevTools detaches the debugger. The pane re-attaches when they close; the domains
      // this needs come back on the next tool call.
      contents.debugger.on('detach', () => { fresh.world = null; this.enabled.delete(contents) })
      contents.on('did-navigate', () => { fresh.world = null; fresh.spaHookInstalled = false })
      contents.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        fresh.pageStart = fresh.requestSeq
        fresh.ready = false
      })
      contents.on('dom-ready', () => {
        fresh.ready = true
        if (this.pane.isAgentTab(tab.id)) void this.injectSpaHook(tab, fresh)
      })
      // A navigation that fails or becomes a download leaves the old document, which is ready.
      contents.on('did-stop-loading', () => { fresh.ready = true })
    }
    state.world = null
    wake(state)
    await contents.debugger.sendCommand('Network.enable')
    await contents.debugger.sendCommand('Page.enable')
    // A tab working in the background still behaves as the focused page it would be for a person.
    await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    this.enabled.add(contents)
    await this.injectSpaHook(tab, state)
    return state
  }

  private async send(tab: TabHandle, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.attach(tab)
    return tab.contents.debugger.sendCommand(method, params)
  }

  private onProtocol(contents: WebContents, state: Attached, method: string, params: Record<string, unknown>): void {
    if (method === 'Page.javascriptDialogOpening') {
      // An open dialog stops the page, and with it every tool call; nobody may be watching this
      // tab to answer it. It is accepted, and the next reading says so.
      state.dialogs.push(`${String(params.type)}: ${String(params.message).slice(0, 200)}`)
      void contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const request = params.request as { url: string; method: string }
      if (!/^https?:/.test(request.url)) return
      state.requests.push({
        id: `r${++state.requestSeq}`, cdpId: String(params.requestId), method: request.method, url: request.url,
        kind: String(params.type ?? ''), status: null, mime: '', size: null
      })
      if (state.requests.length > REQUEST_LOG) state.requests.shift()
      return
    }
    if (method !== 'Network.responseReceived' && method !== 'Network.loadingFinished') return
    const logged = state.requests.findLast((entry) => entry.cdpId === params.requestId)
    if (!logged) return
    if (method === 'Network.responseReceived') {
      const response = params.response as { status: number; mimeType: string }
      logged.status = response.status
      logged.mime = response.mimeType
    } else logged.size = Number(params.encodedDataLength)
  }

  /**
   * Run JavaScript in the tab: in the page's own world, or in the isolated one that holds the
   * page library. A navigation throws the isolated world away, so one stale failure is retried
   * in a new one.
   */
  private async evaluate(tab: TabHandle, expression: string, isolated: boolean, retry = true): Promise<unknown> {
    const state = await this.attach(tab)
    let contextId: number | undefined
    if (isolated) {
      if (state.world === null) {
        const { frameTree } = await tab.contents.debugger.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
        const made = await tab.contents.debugger.sendCommand('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'rocket' }) as { executionContextId: number }
        await tab.contents.debugger.sendCommand('Runtime.evaluate', { expression: PAGE_LIB, contextId: made.executionContextId })
        state.world = made.executionContextId
      }
      contextId = state.world
    }
    let out: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } } }
    try {
      out = await tab.contents.debugger.sendCommand('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId === undefined ? {} : { contextId })
      }) as typeof out
    } catch (error) {
      const stale = /context|navigat|target closed/i.test(error instanceof Error ? error.message : '')
      if (!stale || !retry) throw error
      state.world = null
      await this.settle(tab)
      return this.evaluate(tab, expression, isolated, false)
    }
    const thrown = out.exceptionDetails
    if (thrown) {
      const detail = thrown.exception?.description ?? (thrown.exception?.value === undefined ? thrown.text : String(thrown.exception.value)) ?? 'The script threw'
      // The page library's own errors are sentences for the model; the stack under them is noise.
      throw new Error(isolated ? detail.replace(/^Error: /, '').split('\n')[0]! : detail.split('\n').slice(0, 4).join('\n'))
    }
    return out.result?.value
  }

  // ── Operations ──────────────────────────────────────────────────────

  private readHeader(url: string, title: string, id: string, problem: string | null, dialogs: string): string {
    let hash = '(no hash)'
    let route = ''
    if (url) {
      try {
        const parsed = new URL(url)
        hash = parsed.hash || '(no hash)'
        if (/#\/record\//i.test(parsed.hash)) route = 'route: detail (hash record)'
        else if (parsed.pathname.includes('/spa') && !parsed.hash) route = 'route: list (SPA home)'
      } catch {
        hash = '(url not parseable)'
      }
    }
    const lines = [`# ${title || '(untitled)'}`, `hash: ${hash}`, ...(route ? [route] : []), `${url || '(blank tab)'}  ·  tab ${id}`]
    if (problem) lines.push(`(${problem})`)
    return lines.join('\n') + dialogs
  }

  private async readA11y(tab: TabHandle, maxRefs: number, query: string | null): Promise<string> {
    await this.send(tab, 'Accessibility.enable')
    await this.send(tab, 'DOM.enable')
    const { nodes } = await this.send(tab, 'Accessibility.getFullAXTree', {}) as { nodes: AxNode[] }
    const { text, pins } = buildA11ySnapshot(nodes, maxRefs, query)
    if (pins.length) await this.evaluate(tab, '0', true)
    for (const pin of pins) await this.pinA11yRef(tab, pin.ref, pin.backendDOMNodeId)
    return text
  }

  private async pinA11yRef(tab: TabHandle, ref: string, backendDOMNodeId: number): Promise<void> {
    const resolved = await this.send(tab, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId }) as { object?: { objectId: string } }
    if (!resolved.object?.objectId) return
    const state = await this.attach(tab)
    if (state.world === null) await this.evaluate(tab, '1', true)
    await tab.contents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function(id){ return __rocket.pinRef(id, this); }',
      arguments: [{ value: ref }],
      contextId: state.world!,
      userGesture: true,
      silent: true
    })
  }

  private async read(tab: TabHandle, op: Extract<BrowserAgentOp, { op: 'read' }>, problem: string | null): Promise<string> {
    const { id, url, title } = this.info(tab)
    const state = await this.attach(tab)
    const documentResponse = state.requests.findLast(request => request.kind === 'Document'
      && request.url.split('#')[0] === url.split('#')[0])
    if (problem) throw new Error(problem)
    if (documentResponse?.status && documentResponse.status >= 400) {
      throw new Error(`HTTP ${documentResponse.status} reading ${url}. Try another primary source or web_read.`)
    }
    const dialogs = state.dialogs.splice(0).map((dialog) => `\n(The page raised a dialog, which was accepted. ${dialog})`).join('')
    const parts = [this.readHeader(url, title, id, problem, dialogs)]
    if (op.focus === 'a11y' && url) {
      parts.push(await this.readA11y(tab, op.max ?? 120, op.query ?? null))
    } else if (op.focus !== 'network' && op.focus !== 'a11y' && url) {
      const digestMax = op.query ? (op.focus === 'text' ? 20_000 : 250) : op.max
      const options: DigestOptions = { focus: op.focus, selector: op.selector, max: digestMax }
      let body = String(await this.evaluate(tab, `__rocket.digest(${JSON.stringify(options)})`, true))
      if (op.query) body = filterReadByQuery(body, op.query, op.max)
      parts.push(body)
    }
    if (op.focus === 'all' || op.focus === 'network') {
      const all = op.focus === 'network'
      const calls = state.requests.filter((request) => all || (Number(request.id.slice(1)) > state.pageStart && /^(XHR|Fetch)$/i.test(request.kind)))
      const shown = calls.slice(all ? -(op.max ?? 80) : -12)
      if (shown.length) {
        parts.push(`## ${all ? 'Requests' : 'Data requests the page made'}${calls.length > shown.length ? ` (last ${shown.length} of ${calls.length})` : ''}\n`
          + shown.map((request) =>
            `${request.id} ${request.method} ${request.status ?? '…'} ${request.mime.replace(/^application\//, '') || request.kind} ${sizeOf(request.size)} ${clip(request.url, 160)}`
          ).join('\n'))
      } else if (all) parts.push('(No requests logged. The log starts when a tool first touches the tab; reload to capture a page\'s own.)')
    }
    if (op.attachJson !== false && op.focus !== 'network' && url) {
      const jsonCalls = state.requests.filter((request) =>
        Number(request.id.slice(1)) > state.pageStart && /^(XHR|Fetch)$/i.test(request.kind)
      )
      const attached = await this.attachJsonFromLog(tab, jsonCalls)
      if (attached) parts.push(attached)
    }
    return parts.join('\n\n')
  }

  private async injectSpaHook(tab: TabHandle, state?: Attached): Promise<void> {
    if (!this.pane.isAgentTab(tab.id)) return
    const attached = state ?? this.attached.get(tab.contents)
    if (attached?.spaHookInstalled) return
    try {
      await this.attach(tab)
      await tab.contents.debugger.sendCommand('Runtime.evaluate', { expression: SPA_HOOK })
      const probe = await tab.contents.debugger.sendCommand('Runtime.evaluate', {
        expression: 'Boolean(globalThis.__rocketSpaHook)', returnByValue: true
      }) as { result?: { value?: boolean } }
      if (probe.result?.value && attached) attached.spaHookInstalled = true
    } catch {
      // Non-http pages or destroyed views.
    }
    try {
      await tab.contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SPA_HOOK })
    } catch {
      // Debugger may be unavailable on this view.
    }
  }

  private async attachJsonFromLog(tab: TabHandle, calls: LoggedRequest[]): Promise<string | null> {
    const candidate = [...calls].reverse().find((request) =>
      request.method === 'GET' && request.status === 200 && /json/i.test(request.mime) && request.cdpId
    )
    if (!candidate) return null
    try {
      const { body, base64Encoded } = await this.send(tab, 'Network.getResponseBody', { requestId: candidate.cdpId }) as { body: string; base64Encoded: boolean }
      if (base64Encoded) return null
      return formatAttachedJson(candidate.id, body)
    } catch {
      return null
    }
  }

  private async mark(tab: TabHandle): Promise<null> {
    const state = await this.attach(tab)
    await this.injectSpaHook(tab, state)
    state.scriptMark = state.requestSeq
    state.urlAtMark = tab.contents.getURL()
    state.readSnapshot = String(await this.evaluate(tab, `__rocket.digest(${JSON.stringify({ focus: 'elements', selector: null, max: 60 } satisfies DigestOptions)})`, true).catch(() => ''))
    return null
  }

  private async delta(tab: TabHandle): Promise<string | null> {
    const state = this.attached.get(tab.contents)
    if (!state || state.scriptMark === null) return null
    const parts: string[] = []
    const network = formatNetworkDelta(state.requests, state.scriptMark)
    if (network) parts.push(network)
    const url = tab.contents.getURL()
    if (state.urlAtMark && url !== state.urlAtMark) parts.push(`## Since script started (location)\n${state.urlAtMark} → ${url}`)
    if (state.readSnapshot) {
      const now = String(await this.evaluate(tab, `__rocket.digest(${JSON.stringify({ focus: 'elements', selector: null, max: 60 } satisfies DigestOptions)})`, true).catch(() => ''))
      const page = formatReadDelta(state.readSnapshot, now)
      if (page) parts.push(page)
    }
    state.scriptMark = null
    state.readSnapshot = null
    state.urlAtMark = null
    return parts.length ? parts.join('\n\n') : null
  }

  private async waitSpa(tab: TabHandle, timeout: number): Promise<null> {
    await this.injectSpaHook(tab)
    const start = Number(await this.evaluate(tab, 'globalThis.__rocketSpaNavigation?.seq ?? 0', false) ?? 0)
    const deadline = Date.now() + timeout
    for (;;) {
      const seq = Number(await this.evaluate(tab, 'globalThis.__rocketSpaNavigation?.seq ?? 0', false) ?? 0)
      if (seq > start) return null
      if (Date.now() >= deadline) {
        throw new Error(`Waited ${timeout}ms for a client-side route change (pushState/replaceState/popstate). The page is at ${tab.contents.getURL()}.`)
      }
      await sleep(50)
    }
  }

  /** Bounded wait after goto for hash routes, title, or a matching XHR (opt-in). */
  private async settleAfterGoto(
    tab: TabHandle, url: string, until: GotoUntil, untilValue: string | null, settleTimeout: number | null
  ): Promise<void> {
    const deadline = Date.now() + Math.min(Math.max(settleTimeout ?? SETTLE_CAP_MS, 100), 15_000)
    const state = await this.attach(tab)
    if (until === 'hash') {
      let want: string
      try { want = new URL(url).hash } catch { return }
      if (!want) return
      for (;;) {
        const hash = String(await this.evaluate(tab, 'location.hash', false) ?? '')
        if (hash === want) return
        if (Date.now() >= deadline) throw new Error(`After goto, hash stayed ${hash || '(empty)'} instead of ${want} within ${settleTimeout ?? SETTLE_CAP_MS}ms.`)
        await sleep(50)
      }
    }
    if (until === 'title') {
      const want = untilValue?.trim() ?? ''
      for (;;) {
        const title = tab.contents.getTitle()
        if (title && (!want || title.includes(want))) return
        if (Date.now() >= deadline) throw new Error(`After goto, title "${title}" never matched${want ? ` "${want}"` : ''} within ${settleTimeout ?? SETTLE_CAP_MS}ms.`)
        await sleep(50)
      }
    }
    if (until === 'request') {
      const match = untilValue?.trim() ?? ''
      if (!match) throw new Error('tab.goto(..., { until: "request", untilValue: "url fragment" }) needs untilValue.')
      for (;;) {
        const hit = state.requests.find((request) =>
          request.url.includes(match) && request.status === 200 && Number(request.id.slice(1)) > state.pageStart
        )
        if (hit) return
        if (Date.now() >= deadline) throw new Error(`After goto, no GET ${match} with status 200 appeared within ${settleTimeout ?? SETTLE_CAP_MS}ms.`)
        await sleep(50)
      }
    }
  }

  private async locate(tab: TabHandle, target: string, retry = true): Promise<{ x: number; y: number }> {
    try {
      return await this.evaluate(tab, `__rocket.locate(${JSON.stringify(target)})`, true) as { x: number; y: number }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const stale = /no longer on the page|Nothing on the page says/.test(msg)
      if (!stale || !retry) {
        if (/no longer on the page/.test(msg)) {
          throw new Error(`${target} is stale. Read the page again (capture a new snapshot) for current refs.`)
        }
        throw error
      }
      await this.evaluate(tab, `__rocket.digest(${JSON.stringify({ focus: 'elements', selector: null, max: 150 } satisfies DigestOptions)})`, true)
      return this.locate(tab, target, false)
    }
  }

  private async focusTarget(tab: TabHandle, target: string, value: string, retry = true): Promise<'typed' | 'set'> {
    try {
      return await this.evaluate(tab, `__rocket.focus(${JSON.stringify(target)}, ${JSON.stringify(value)})`, true) as 'typed' | 'set'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const stale = /no longer on the page|Nothing on the page says/.test(msg)
      if (!stale || !retry) {
        if (/no longer on the page/.test(msg)) {
          throw new Error(`${target} is stale. Read the page again (capture a new snapshot) for current refs.`)
        }
        throw error
      }
      await this.evaluate(tab, `__rocket.digest(${JSON.stringify({ focus: 'elements', selector: null, max: 150 } satisfies DigestOptions)})`, true)
      return this.focusTarget(tab, target, value, false)
    }
  }

  /** A real click at the target's centre; if it starts a navigation, the new page is waited for. */
  private async click(tab: TabHandle, target: string): Promise<void> {
    const { x, y } = await this.locate(tab, target)
    const point = { x, y, button: 'left', clickCount: 1 }
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
    await this.settle(tab)
  }

  private async press(tab: TabHandle, combo: string): Promise<void> {
    const names = combo.split('+').map((part) => part.trim()).filter(Boolean)
    const name = names.pop() ?? ''
    let modifiers = 0
    for (const modifier of names) {
      if (!(modifier in MODIFIERS)) throw new Error(`"${modifier}" is not a modifier key. Use Control, Shift, Alt or Meta.`)
      modifiers |= MODIFIERS[modifier]!
    }
    const known = KEYS[name]
    if (!known && name.length !== 1) throw new Error(`"${name}" is not a key this knows. Keys: ${Object.keys(KEYS).join(', ')}, or one character.`)
    const key = known
      ? { key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: known.code, ...(known.text && !modifiers ? { text: known.text } : {}) }
      : { key: name, code: /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : '', windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), ...(modifiers ? {} : { text: name }) }
    await this.send(tab, 'Input.dispatchKeyEvent', { type: 'text' in key ? 'keyDown' : 'rawKeyDown', modifiers, ...key })
    await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...key })
  }

  private async wait(tab: TabHandle, op: Extract<BrowserAgentOp, { op: 'wait' }>): Promise<null> {
    const deadline = Date.now() + op.timeout
    const check = op.target ? `__rocket.has(${JSON.stringify(op.target)})` : `Boolean(${op.expression})`
    for (;;) {
      // A page in the middle of navigating has nothing to ask; it will, shortly.
      const met = await this.evaluate(tab, check, op.target !== null).catch(() => false)
      if (met) return null
      if (Date.now() >= deadline) throw new Error(`Waited ${op.timeout}ms and ${op.target ?? 'the condition'} never came true. The page is at ${tab.contents.getURL()}.`)
      await sleep(100)
    }
  }

  private async fetch(op: Extract<BrowserAgentOp, { op: 'fetch' }>): Promise<unknown> {
    const response = await session.fromPartition(PARTITION).fetch(op.url, {
      method: op.method ?? (op.body === null ? 'GET' : 'POST'),
      ...(op.headers ? { headers: op.headers } : {}),
      ...(op.body === null ? {} : { body: op.body })
    })
    const type = response.headers.get('content-type') ?? ''
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > FETCH_LIMIT) throw new Error(`The response is ${sizeOf(bytes.length)}, over the ${sizeOf(FETCH_LIMIT)} limit.`)
    const textual = /json|text|xml|javascript|csv|html/i.test(type) || !type
    return {
      status: response.status,
      url: response.url,
      type,
      body: textual ? bytes.toString('utf8') : { base64: bytes.toString('base64') }
    }
  }
}

function sizeOf(bytes: number | null): string {
  if (bytes === null) return ''
  return bytes < 1_000 ? `${bytes}B` : bytes < 1_000_000 ? `${Math.round(bytes / 1_000)}kB` : `${(bytes / 1_000_000).toFixed(1)}MB`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
