import {
  app, clipboard, dialog, Menu, session, WebContentsView,
  type BrowserWindow, type ContextMenuParams, type Event, type Input, type MenuItemConstructorOptions,
  type Rectangle, type Session, type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTab, Bounds, BrowserCommand, BrowserState, BrowserTab } from '../shared/types.ts'
import { CHROME_OBJECT_SCRIPT } from './chrome-object.ts'
import { detectCookieSources, importCookies, type CookieSource } from './cookie-import.ts'
import { Suggestions } from './browser-suggest.ts'
import { ReadingScroll } from './reading-scroll.ts'
import { nudgeSpeed } from '../shared/reading.ts'
import {
  ACCEPT_LANGUAGES, BROWSER_PARTITION, clientHintHeaders, conceal, isBlankTabUrl, isNewTabUrl, NEW_TAB_URL, PAGE_BACKGROUND, parseAcceptCh,
  plainUserAgent, reveal, toUrl, userAgentMetadata
} from './browser-url.ts'

// The embedded browser: a strip of tabs, each a WebContentsView laid over the region of the
// window the UI reserves for the page. A view is a native surface, so it paints above every DOM
// layer; the UI is laid out so that nothing it draws ever needs to overlap that region, and the
// one thing that must (the address field's dropdown) is a view of its own.
//
// Only the active tab's view is on screen. The others are concealed (see browser-url.ts), and a
// tab restored from the last session has no view at all until it is first selected, as in
// Chromium.

const PARTITION = BROWSER_PARTITION
const REOPEN_LIMIT = 25
const FAVICON_LIMIT = 64_000

type Tab = {
  id: string
  /** The short name models know the tab by. */
  ref: string
  /** Opened by a model for its own work. */
  agent: boolean
  /** Null until the tab is first shown. */
  view: WebContentsView | null
  url: string
  title: string
  favicon: string | null
  faviconUrl: string | null
  pinned: boolean
}

type SavedTab = Pick<Tab, 'url' | 'title' | 'favicon' | 'pinned'>
type ClosedTab = SavedTab & { index: number }
type NewTab = Partial<SavedTab> & { index?: number; view?: WebContentsView; agent?: boolean }

/** A tab as the browser tools hold it. */
export type TabHandle = { id: string; contents: WebContents }

export class BrowserPane {
  private readonly suggestions: Suggestions
  /** Hands-free reading, per tab, at one shared speed (reading-scroll.ts). */
  private readonly reading: ReadingScroll
  private readonly sessionFile = join(app.getPath('userData'), 'browser-tabs.json')
  private tabs: Tab[] = []
  private activeId: string | null = null
  private closed: ClosedTab[] = []
  private restored = false
  /** Where the UI wants the page; null while the browser is hidden. */
  private bounds: Rectangle | null = null
  private size = { width: 800, height: 600 }
  /** Whether keyboard focus is in the browser's toolbar, in the UI's page. */
  private chromeFocused = false
  private publishQueued = false
  /** Whether what changed belongs in the saved session (reading progress, a few times a second, does not). */
  private saveWanted = false
  /** Per page, the promise that it has been made to present as Chrome (presentAsChrome). */
  private readonly presenting = new WeakMap<WebContents, Promise<void>>()
  private readonly closing = new WeakSet<WebContents>()
  private saveTimer: NodeJS.Timeout | null = null
  private disposed = false
  private refSeq = 0

  constructor(private readonly window: BrowserWindow) {
    // Set before any tab exists: a session's user agent only reaches pages made after it.
    const pages = session.fromPartition(PARTITION)
    pages.setUserAgent(plainUserAgent(pages.getUserAgent(), app.name), ACCEPT_LANGUAGES)
    this.sendClientHints(pages)
    this.suggestions = new Suggestions(window)
    this.reading = new ReadingScroll(() => this.publish(false), () => (this.bounds ? this.active?.view?.webContents ?? null : null))
    window.on('resize', () => {
      for (const tab of this.tabs) {
        if (tab.view && !(this.bounds && tab.id === this.activeId)) conceal(window, tab.view)
      }
    })
    window.on('close', () => {
      this.save()
      this.disposed = true
      this.suggestions.dispose()
      this.reading.dispose()
      for (const tab of this.tabs) tab.view?.webContents.close()
    })
    // Tab shortcuts typed while focus is in the toolbar rather than in a page.
    window.webContents.on('before-input-event', (event, input) => {
      if (this.chromeFocused && this.bounds) this.onKey(event, input)
    })
  }

  handle(sender: WebContents, command: BrowserCommand): void {
    if (this.suggestions.owns(sender)) {
      if (command.type === 'suggestPick') this.navigate(String(command.value))
      return
    }
    if (sender !== this.window.webContents) return
    switch (command.type) {
      case 'setBounds': this.setBounds(command.bounds); break
      case 'sync': this.restore(); this.publish(); break
      case 'chromeFocus': this.chromeFocused = command.focused === true; break
      case 'newTab': this.restore(); this.newTab(command.url); break
      case 'closeTab': this.closeTab(this.find(command.id)); break
      case 'activateTab': this.activate(this.find(command.id), true); break
      case 'moveTab': this.moveTab(this.find(command.id), Number(command.index)); break
      case 'muteTab': this.mute(this.find(command.id), command.muted === true); break
      case 'tabMenu': this.tabMenu(this.find(command.id)); break
      case 'navigate': this.navigate(String(command.input ?? '')); break
      case 'back': this.active?.view?.webContents.navigationHistory.goBack(); break
      case 'forward': this.active?.view?.webContents.navigationHistory.goForward(); break
      case 'reload': this.active?.view?.webContents.reload(); break
      case 'stop': this.active?.view?.webContents.stop(); break
      case 'suggest': this.suggestions.query(String(command.text ?? ''), command.anchor); break
      case 'suggestSelect': this.suggestions.select(Number(command.index)); break
      case 'suggestHide': this.suggestions.hide(); break
      case 'reading': void this.readingAction(command.action); break
      case 'readingSpeed': this.reading.setSpeed(Number(command.speed)); this.saveSoon(); break
    }
  }

  // ── For the browser tools (browser-agent.ts) ─────────────────────────

  agentTabs(): AgentTab[] {
    // A model may ask before the user has ever opened the browser panel.
    this.restore()
    return this.tabs.map((tab) => ({
      id: tab.ref,
      url: isBlankTabUrl(tab.url) ? '' : tab.url,
      title: isBlankTabUrl(tab.url) ? 'New Tab' : tab.title,
      active: tab.id === this.activeId,
      loading: tab.view?.webContents.isLoading() ?? false,
      agent: tab.agent
    }))
  }

  /** A tab by the name models know it by, with its page loaded. */
  isAgentTab(ref: string): boolean {
    return this.tabs.some((entry) => entry.ref === ref && entry.agent)
  }

  agentTab(ref: string): TabHandle | null {
    this.restore()
    const tab = this.tabs.find((entry) => entry.ref === ref)
    return tab ? { id: tab.ref, contents: (tab.view ?? this.load(tab)).webContents } : null
  }

  agentActive(): TabHandle | null {
    this.restore()
    return this.active ? this.agentTab(this.active.ref) : null
  }

  /** A tab for a model to work in. The strip switches to it so the user can follow along. */
  agentOpen(): TabHandle {
    this.restore()
    const tab = this.createTab({ url: 'about:blank', agent: true })
    this.activate(tab, false)
    const view = tab.view ?? this.load(tab)
    return { id: tab.ref, contents: view.webContents }
  }

  /** Show an agent tab the model is using without moving keyboard focus into the page. */
  agentShow(ref: string): void {
    this.restore()
    const tab = this.tabs.find((entry) => entry.ref === ref)
    if (!tab?.agent || tab.id === this.activeId) return
    this.activate(tab, false)
  }

  async agentClose(ref: string): Promise<void> {
    this.restore()
    const tab = this.tabs.find((entry) => entry.ref === ref)
    if (!tab) throw new Error(`There is no tab ${ref}.`)
    const contents = tab.view?.webContents
    // Finish native teardown before a script closes the next tab. A restored tab needs no
    // renderer, navigation or debugger session just to remove it from the strip.
    const destroyed = contents && !contents.isDestroyed()
      ? new Promise<void>(resolve => contents.once('destroyed', resolve)) : Promise.resolve()
    this.closeTab(tab)
    await destroyed
  }

  // ── Tabs ────────────────────────────────────────────────────────────

  private get active(): Tab | null {
    return this.find(this.activeId)
  }

  private find(id: string | null): Tab | null {
    return this.tabs.find((tab) => tab.id === id) ?? null
  }

  private get pinnedCount(): number {
    return this.tabs.filter((tab) => tab.pinned).length
  }

  /** Bring back the last session's tabs, or start with one new tab. Runs once, when the browser is first shown. */
  private restore(): void {
    if (this.restored) return
    this.restored = true
    let saved: { active?: number; tabs?: SavedTab[]; readingSpeed?: unknown } = {}
    try {
      saved = JSON.parse(readFileSync(this.sessionFile, 'utf8')) as typeof saved
    } catch {
      // No session yet.
    }
    this.reading.restoreSpeed(saved.readingSpeed)
    const tabs = (Array.isArray(saved.tabs) ? saved.tabs : []).filter((tab) => typeof tab?.url === 'string')
    for (const tab of tabs) this.createTab(tab)
    this.activate(this.tabs[saved.active ?? 0] ?? this.tabs[0] ?? this.createTab({}), false)
  }

  private createTab(from: NewTab): Tab {
    const tab: Tab = {
      id: randomUUID(),
      ref: `t${++this.refSeq}`,
      agent: from.agent === true,
      view: null,
      url: from.url ?? NEW_TAB_URL,
      title: from.title ?? '',
      favicon: from.favicon ?? null,
      faviconUrl: null,
      pinned: from.pinned === true
    }
    const pinned = this.pinnedCount
    const index = Math.min(Math.max(from.index ?? this.tabs.length, tab.pinned ? 0 : pinned), tab.pinned ? pinned : this.tabs.length)
    this.tabs.splice(index, 0, tab)
    if (from.view) this.adopt(tab, from.view)
    this.publish()
    return tab
  }

  private newTab(url?: string, index?: number): void {
    this.activate(this.createTab({ url, index }), false)
    if (!url) this.focusAddress()
  }

  private activate(tab: Tab | null, focusPage: boolean): void {
    if (!tab) return
    const previous = this.active
    this.activeId = tab.id
    const view = tab.view ?? this.load(tab)
    this.paintPageBackdrop(view)
    // The new page goes up before the old one comes down, so the stage is never empty.
    this.place()
    if (previous && previous !== tab && previous.view) conceal(this.window, previous.view)
    // A tab out of sight stops scrolling and waits, in its place, for the reader to come back.
    if (previous && previous !== tab) void this.reading.pause(previous.view?.webContents)
    this.suggestions.hide()
    if (focusPage) view.webContents.focus()
    this.publish()
  }

  private closeTab(tab: Tab | null): void {
    if (!tab) return
    const index = this.tabs.indexOf(tab)
    if (!isNewTabUrl(tab.url)) {
      this.closed.push({ url: tab.url, title: tab.title, favicon: tab.favicon, pinned: tab.pinned, index })
      if (this.closed.length > REOPEN_LIMIT) this.closed.shift()
    }
    this.tabs.splice(index, 1)
    if (this.activeId === tab.id) {
      this.activeId = null
      // The tab to the right takes over, or the one to the left of the last; closing the only
      // tab leaves a new one, since the browser has no window of its own to close.
      this.activate(this.tabs[index] ?? this.tabs[index - 1] ?? this.createTab({}), true)
    }
    if (tab.view) {
      const view = tab.view, contents = view.webContents
      this.closing.add(contents)
      // Stop navigation and protocol traffic before releasing the native view. Closing is
      // asynchronous in Electron; isDestroyed() alone does not cover this interval.
      contents.stop()
      if (contents.debugger.isAttached()) contents.debugger.detach()
      this.window.contentView.removeChildView(view)
      contents.close()
    }
    this.publish()
  }

  private reopenClosed(): void {
    const tab = this.closed.pop()
    if (tab) this.activate(this.createTab(tab), true)
  }

  private moveTab(tab: Tab | null, index: number): void {
    if (!tab || !Number.isInteger(index)) return
    this.tabs.splice(this.tabs.indexOf(tab), 1)
    const pinned = this.pinnedCount
    this.tabs.splice(Math.min(Math.max(index, tab.pinned ? 0 : pinned), tab.pinned ? pinned : this.tabs.length), 0, tab)
    this.publish()
  }

  private pin(tab: Tab, pinned: boolean): void {
    this.tabs.splice(this.tabs.indexOf(tab), 1)
    tab.pinned = pinned
    // Pinning puts the tab after the other pinned ones; unpinning puts it first among the rest.
    this.tabs.splice(this.pinnedCount - (pinned ? 1 : 0), 0, tab)
    this.publish()
  }

  private mute(tab: Tab | null, muted: boolean): void {
    tab?.view?.webContents.setAudioMuted(muted)
    this.publish()
  }

  private step(by: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId)
    this.activate(this.tabs[(index + by + this.tabs.length) % this.tabs.length] ?? null, true)
  }

  // ── Views ───────────────────────────────────────────────────────────

  private setBounds(bounds: Bounds | null): void {
    if (!bounds || !(bounds.width >= 2) || !(bounds.height >= 2)) {
      void this.reading.pause(this.active?.view?.webContents)
      this.bounds = null
      this.suggestions.hide()
    } else {
      this.size = { width: Math.round(bounds.width), height: Math.round(bounds.height) }
      this.bounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), ...this.size }
      this.restore()
    }
    this.place()
  }

  /** Put the active tab's page where the UI wants it, or out of sight while the browser is hidden. */
  private place(): void {
    const view = this.active?.view
    if (!view) return
    if (this.bounds) reveal(view, this.bounds)
    else conceal(this.window, view)
  }

  // The constructor gives the session Chrome's plain user agent, which reaches the User-Agent
  // header and navigator.userAgent. navigator.userAgentData, though, is filled from metadata the
  // public API cannot set, so a page saw a browser claiming Chrome whose page API said plain
  // Chromium: one of the inconsistencies bot checks such as Cloudflare's challenge key on. The
  // DevTools protocol can set that metadata, per page, for as long as it is attached; attaching
  // alone enables no domain and is not visible to the page. Opening DevTools detaches it, so the
  // override is put back when they close. It changes nothing on the wire: Electron sends no
  // client-hint headers through any path, so sendClientHints adds those. Accept-Language is left
  // to the session, whose value already comes out as Chrome's ("en-US,en;q=0.9").
  private presentAsChrome(contents: WebContents): Promise<void> {
    const userAgent = session.fromPartition(PARTITION).getUserAgent()
    const metadata = userAgentMetadata(userAgent)
    if (!metadata) return Promise.resolve()
    const apply = async (): Promise<void> => {
      if (contents.isDestroyed() || this.closing.has(contents) || contents.isDevToolsOpened()) return
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
        // Scripts for new documents only run while the Page domain is on; the domain itself is not
        // visible to pages. The script fills window.chrome as Chrome has it (chrome-object.ts) in
        // every frame, and `runImmediately` covers a document that already exists.
        await contents.debugger.sendCommand('Page.enable')
        if (contents.isDestroyed() || this.closing.has(contents)) return
        await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_OBJECT_SCRIPT, runImmediately: true })
        if (contents.isDestroyed() || this.closing.has(contents)) return
        // acceptLanguage here is what sets navigator.languages, which Electron otherwise reads as
        // ["en-US", "en", "en"]; the Accept-Language header stays the session's, already Chrome's.
        await contents.debugger.sendCommand('Network.setUserAgentOverride', { userAgent, acceptLanguage: ACCEPT_LANGUAGES, userAgentMetadata: metadata })
      } catch {
        // Without the override the page still works; it just looks like Electron, as before.
      }
    }
    contents.on('devtools-closed', () => void apply())
    return apply()
  }

  // Protocol commands are carried out once a page has a renderer, and a new view has none until
  // it navigates: sent before the first load, they are still queued when the first document is
  // made, and that document misses them. So a new view first loads a blank document for them to
  // land in, then the real page with everything in place. The blank page is scaffolding, not
  // somewhere to go back to; it is taken out of history once the next page is in (see adopt).
  private async loadPresented(contents: WebContents, url: string): Promise<void> {
    try {
      await contents.loadURL('about:blank')
      await this.presenting.get(contents)
      if (contents.isDestroyed() || this.closing.has(contents)) return
      // A tab opened blank (a model's, before its first goto) is already where it should be.
      if (isBlankTabUrl(url)) return
      // Someone (a tool, the user) may have sent the tab elsewhere meanwhile; their page wins.
      if (contents.isDestroyed() || contents.isLoadingMainFrame() || !isBlankTabUrl(contents.getURL())) return
      await contents.loadURL(url)
    } catch {
      // A failed load shows Chromium's error page, as before.
    }
  }

  // Chromium adds Sec-CH-UA headers only through a client-hints delegate, and Electron has none
  // (ElectronBrowserContext::GetClientHintsControllerDelegate returns null, Electron 44), so a
  // page here got none at all. These are the headers a real Chrome of this version sends, from the
  // same metadata presentAsChrome gives navigator.userAgentData: the three low-entropy hints on
  // every HTTPS request, and the high-entropy ones to an origin that asked for them with Accept-CH,
  // remembered for the run as Chrome remembers them. A Critical-CH restart is not emulated: such
  // an origin gets its extra hints from its second request on.
  private sendClientHints(pages: Session): void {
    const metadata = userAgentMetadata(pages.getUserAgent())
    if (!metadata) return
    const askedFor = new Map<string, Set<string>>()
    pages.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, done) => {
      const hints = clientHintHeaders(metadata, askedFor.get(origin(details.url)) ?? [])
      done({ requestHeaders: { ...details.requestHeaders, ...hints } })
    })
    pages.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, done) => {
      const accept = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'accept-ch')?.[1]
      if (accept) {
        const key = origin(details.url)
        const wanted = askedFor.get(key) ?? new Set<string>()
        for (const name of parseAcceptCh(accept)) wanted.add(name)
        askedFor.set(key, wanted)
      }
      done({})
    })
  }

  private load(tab: Tab): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.adopt(tab, view)
    void this.loadPresented(view.webContents, tab.url)
    return view
  }

  /** The colour Chromium shows while a page is loading or between paints. */
  private paintPageBackdrop(view: WebContentsView): void {
    view.setBackgroundColor(PAGE_BACKGROUND)
  }

  /** Make a view this tab's page: put it in the window, out of sight, and follow what it does. */
  private adopt(tab: Tab, view: WebContentsView): void {
    tab.view = view
    view.setBorderRadius(8)
    this.paintPageBackdrop(view)
    this.window.contentView.addChildView(view)
    // The dropdown's view stays the top one. (Inserting the tab beneath it by index instead
    // leaves the tab's page unpainted.)
    this.suggestions.raise()
    view.setBounds({ x: 0, y: 0, ...this.size })
    conceal(this.window, view)

    const contents = view.webContents
    this.presenting.set(contents, this.presentAsChrome(contents))
    const history = this.suggestions.history
    const changed = (): void => {
      const url = contents.getURL()
      // The blank document a new view is primed with (loadPresented) is not where the tab is going.
      if (url && !(isBlankTabUrl(url) && !isBlankTabUrl(tab.url))) tab.url = url
      tab.title = contents.getTitle()
      this.publish()
    }
    contents.on('did-start-loading', changed)
    contents.on('did-stop-loading', changed)
    contents.on('audio-state-changed', changed)
    contents.on('did-navigate', (_event, url) => {
      // Reading belongs to the page it started on.
      this.reading.forget(contents)
      // A new site starts without an icon; within a site the old one stays until replaced.
      if (origin(url) !== origin(tab.url)) tab.favicon = tab.faviconUrl = null
      changed()
      history.visit(url, contents.getTitle())
      // Once a real page is in, the primed blank document (loadPresented) leaves the history.
      const history_ = contents.navigationHistory
      while (history_.getActiveIndex() > 0 && isBlankTabUrl(history_.getAllEntries()[0]?.url ?? '')) {
        if (!history_.removeEntryAtIndex(0)) break
      }
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      changed()
      if (isMainFrame) history.visit(url, contents.getTitle())
    })
    contents.on('page-title-updated', (_event, title) => {
      changed()
      history.setTitle(contents.getURL(), title)
    })
    contents.on('page-favicon-updated', (_event, urls) => {
      if (urls[0]) void this.loadFavicon(tab, urls[0])
    })
    contents.on('render-process-gone', () => this.reading.forget(contents))
    contents.on('before-input-event', (event, input) => {
      // Esc stops reading and still reaches the page, which may have its own use for it.
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.alt && !input.control && !input.meta && this.reading.of(contents)) {
        void this.reading.stop(contents)
      }
      this.onKey(event, input)
    })
    contents.on('context-menu', (_event, params) => this.pageMenu(tab, params))
    // A page that closes itself (window.close()) closes its tab.
    contents.on('destroyed', () => {
      this.reading.forget(contents)
      tab.view = null
      if (this.tabs.includes(tab) && !this.disposed) this.closeTab(tab)
    })
    // A link that wants a new window gets a new tab next to this one. Chromium makes the page
    // itself and hands it over, so the opener relationship (window.opener, postMessage) holds.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' }
      return {
        action: 'allow',
        createWindow: (options) => {
          const opened = this.createTab({
            url,
            index: this.tabs.indexOf(tab) + 1,
            view: new WebContentsView({ webContents: (options as { webContents?: WebContents }).webContents, webPreferences: options.webPreferences })
          })
          if (disposition !== 'background-tab') this.activate(opened, true)
          return opened.view!.webContents
        }
      }
    })
  }

  private async loadFavicon(tab: Tab, url: string): Promise<void> {
    if (tab.faviconUrl === url) return
    tab.faviconUrl = url
    try {
      let icon = url
      // "data:," is how a page says it has no icon.
      if (url.startsWith('data:') && url.length < 32) icon = ''
      else if (!url.startsWith('data:')) {
        // Fetched with the browser's own session, so it comes with the site's cookies and the
        // UI's page never has to load anything from the network.
        const response = await session.fromPartition(PARTITION).fetch(url)
        const bytes = Buffer.from(await response.arrayBuffer())
        if (!response.ok || !bytes.length) return
        const type = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/x-icon'
        icon = `data:${type};base64,${bytes.toString('base64')}`
      }
      if (tab.faviconUrl !== url || icon.length > FAVICON_LIMIT) return
      tab.favicon = icon || null
      this.publish()
    } catch {
      // No icon; the tab keeps the default one.
    }
  }

  private navigate(input: string): void {
    const tab = this.active
    const url = toUrl(input)
    this.suggestions.hide()
    if (!tab || !url) return
    tab.url = url
    const view = tab.view ?? this.load(tab)
    void view.webContents.loadURL(url).catch(() => {})
    view.webContents.focus()
  }

  private focusAddress(): void {
    // The state goes first, so the address field already shows this tab when it takes focus.
    this.flush()
    this.window.webContents.focus()
    this.window.webContents.send('rocket:browser-focus-address')
  }

  // ── Keyboard and menus ──────────────────────────────────────────────

  /** Chromium's tab and navigation shortcuts. */
  private onKey(event: Event, input: Input): void {
    if (input.type !== 'keyDown') return
    const run = this.shortcut(input)
    if (!run) return
    event.preventDefault()
    run()
  }

  private shortcut(input: Input): (() => void) | null {
    const key = input.key.toLowerCase()
    const contents = this.active?.view?.webContents
    if (input.control && !input.alt && !input.meta) {
      if (input.shift) {
        if (key === 't') return () => this.reopenClosed()
        if (key === 'tab') return () => this.step(-1)
        if (key === 'r') return () => contents?.reloadIgnoringCache()
        if (key === 'i') return () => contents?.openDevTools({ mode: 'detach' })
        if (key === '+') return () => this.zoom(1)
        return null
      }
      if (key === 't') return () => this.newTab()
      if (key === 'w' || key === 'f4') return () => this.closeTab(this.active)
      if (key === 'tab' || key === 'pagedown') return () => this.step(1)
      if (key === 'pageup') return () => this.step(-1)
      if (key === 'l') return () => this.focusAddress()
      if (key === 'r') return () => contents?.reload()
      if (key === '=' || key === '+') return () => this.zoom(1)
      if (key === '-') return () => this.zoom(-1)
      if (key === '0') return () => contents?.setZoomLevel(0)
      if (/^[1-8]$/.test(key)) return () => this.activate(this.tabs[Number(key) - 1] ?? null, true)
      if (key === '9') return () => this.activate(this.tabs.at(-1) ?? null, true)
      return null
    }
    if (input.alt && !input.control && !input.meta && !input.shift) {
      if (key === 'arrowleft') return () => contents?.navigationHistory.goBack()
      if (key === 'arrowright') return () => contents?.navigationHistory.goForward()
      if (key === 'd') return () => this.focusAddress()
      if (key === 's' && contents) return () => void this.reading.flip(contents)
      if ((key === 'arrowup' || key === 'arrowdown') && this.reading.of(contents)) {
        return () => { this.reading.setSpeed(nudgeSpeed(this.reading.speed, key === 'arrowup' ? -1 : 1)); this.saveSoon() }
      }
      return null
    }
    if (!input.alt && !input.control && !input.meta) {
      if (key === 'f5') return () => contents?.reload()
      if (key === 'f6') return () => this.focusAddress()
      if (key === 'f12') return () => contents?.openDevTools({ mode: 'detach' })
    }
    return null
  }

  private zoom(by: number): void {
    const contents = this.active?.view?.webContents
    contents?.setZoomLevel(Math.min(Math.max(contents.getZoomLevel() + by * 0.5, -3), 4))
  }

  private tabMenu(tab: Tab | null): void {
    if (!tab) return
    const index = this.tabs.indexOf(tab)
    const contents = tab.view?.webContents
    const muted = contents?.isAudioMuted() ?? false
    Menu.buildFromTemplate([
      { label: 'New tab to the right', click: () => this.newTab(undefined, index + 1) },
      { type: 'separator' },
      { label: 'Reload', click: () => (tab.view ?? this.load(tab)).webContents.reload() },
      { label: 'Duplicate', click: () => this.activate(this.createTab({ url: tab.url, title: tab.title, favicon: tab.favicon, index: index + 1 }), true) },
      { label: tab.pinned ? 'Unpin' : 'Pin', click: () => this.pin(tab, !tab.pinned) },
      { label: muted ? 'Unmute site' : 'Mute site', enabled: Boolean(contents), click: () => this.mute(tab, !muted) },
      { type: 'separator' },
      { label: 'Close', click: () => this.closeTab(tab) },
      {
        label: 'Close other tabs',
        enabled: this.tabs.some((other) => other !== tab && !other.pinned),
        click: () => { for (const other of [...this.tabs]) if (other !== tab && !other.pinned) this.closeTab(other) }
      },
      {
        label: 'Close tabs to the right',
        enabled: this.tabs.slice(index + 1).some((other) => !other.pinned),
        click: () => { for (const other of this.tabs.slice(this.tabs.indexOf(tab) + 1)) if (!other.pinned) this.closeTab(other) }
      },
      { type: 'separator' },
      { label: 'Reopen closed tab', enabled: this.closed.length > 0, click: () => this.reopenClosed() }
    ]).popup({ window: this.window })
  }

  private pageMenu(tab: Tab, params: ContextMenuParams): void {
    const contents = tab.view?.webContents
    if (!contents) return
    const beside = this.tabs.indexOf(tab) + 1
    const items: MenuItemConstructorOptions[] = []
    const selection = params.selectionText.trim()
    if (params.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => void this.load(this.createTab({ url: params.linkURL, index: beside })) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.mediaType === 'image') {
      items.push(
        { label: 'Open image in new tab', click: () => this.newTab(params.srcURL, beside) },
        { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      items.push(
        { label: 'Cut', enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: 'Select all', enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
        { type: 'separator' }
      )
    } else if (selection) {
      const shown = selection.length > 30 ? `${selection.slice(0, 30)}…` : selection
      items.push(
        { label: 'Copy', click: () => contents.copy() },
        { label: `Search Google for “${shown}”`, click: () => this.newTab(`https://www.google.com/search?q=${encodeURIComponent(selection)}`, beside) },
        { type: 'separator' }
      )
    }
    if (!items.length) {
      items.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' }
      )
    }
    const importItem = this.cookieImportItem(tab)
    if (importItem) items.push(importItem, { type: 'separator' })
    items.push({ label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup({ window: this.window })
  }

  // Let the user pull their logged-in sessions from an OS browser into this one. Built here, in
  // the native menu, so the manual import needs no round-trip through the renderer.
  private cookieImportItem(tab: Tab): MenuItemConstructorOptions | null {
    const sources = detectCookieSources()
    if (!sources.length) return null
    const host = hostOf(tab.url)
    const submenu: MenuItemConstructorOptions[] = sources.map((source) => {
      const perBrowser: MenuItemConstructorOptions[] = []
      if (host) perBrowser.push({ label: `This site (${host})`, click: () => void this.runImport(source, host) })
      perBrowser.push({ label: 'All sites', click: () => void this.runImport(source) })
      return { label: source.label, submenu: perBrowser }
    })
    return { label: 'Import login cookies', submenu }
  }

  private async runImport(source: CookieSource, host?: string): Promise<void> {
    try {
      const result = await importCookies(session.fromPartition(PARTITION), source, host)
      const where = host ? `for ${host}` : 'for all sites'
      const extra = result.skipped ? ` ${result.skipped} were skipped.` : ''
      void dialog.showMessageBox(this.window, {
        type: 'info',
        message: `Imported ${result.imported} cookies from ${source.label} ${where}.${extra}`,
        detail: 'Reload the page to use the imported session.',
        buttons: ['Reload', 'Close'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) this.active?.view?.webContents.reload()
      })
    } catch (error) {
      void dialog.showMessageBox(this.window, {
        type: 'error',
        message: `Could not import cookies from ${source.label}.`,
        detail: error instanceof Error ? error.message : 'The browser profile could not be read.'
      })
    }
  }

  // ── State ───────────────────────────────────────────────────────────

  private snapshot(tab: Tab): BrowserTab {
    const contents = tab.view?.webContents
    const blank = isBlankTabUrl(tab.url)
    return {
      id: tab.id,
      url: blank ? '' : tab.url,
      title: blank ? 'New Tab' : tab.title || tab.url,
      favicon: blank ? null : tab.favicon,
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      pinned: tab.pinned,
      audible: contents?.isCurrentlyAudible() ?? false,
      muted: contents?.isAudioMuted() ?? false,
      agent: tab.agent,
      reading: this.reading.of(contents)
    }
  }

  /** Tell the UI what changed. Coalesced, because one navigation raises several events at once. */
  private publish(save = true): void {
    if (save) this.saveWanted = true
    if (this.publishQueued) return
    this.publishQueued = true
    setImmediate(() => this.flush())
  }

  private flush(): void {
    this.publishQueued = false
    if (this.disposed || this.window.isDestroyed() || !this.restored) return
    const state: BrowserState = { tabs: this.tabs.map((tab) => this.snapshot(tab)), activeId: this.activeId, readingSpeed: this.reading.speed }
    this.window.webContents.send('rocket:browser-state', state)
    if (this.saveWanted) this.saveSoon()
    this.saveWanted = false
  }

  private saveSoon(): void {
    this.saveTimer ??= setTimeout(() => this.save(), 1_000)
  }

  private async readingAction(action: 'flip' | 'toggle' | 'stop'): Promise<void> {
    const contents = this.active?.view?.webContents
    if (!contents) return
    if (action === 'flip') await this.reading.flip(contents)
    else if (action === 'toggle') await this.reading.toggle(contents)
    else await this.reading.stop(contents)
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.restored) return
    // A model's working tabs are not part of the user's session.
    const kept = this.tabs.filter((tab) => !tab.agent)
    const tabs: SavedTab[] = kept.map(({ url, title, favicon, pinned }) => ({ url, title, favicon, pinned }))
    try {
      const active = Math.max(0, kept.findIndex((tab) => tab.id === this.activeId))
      writeFileSync(this.sessionFile, JSON.stringify({ active, tabs, readingSpeed: this.reading.speed }))
    } catch {
      // The session is a convenience; the browser works without it.
    }
  }
}

function origin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** The hostname of a real page, or null for a blank/home/non-web tab. */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname || null
  } catch {
    return null
  }
}
