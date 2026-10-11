import { app, net, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bounds, Suggestion, SuggestionList } from '../shared/types.ts'
import { SUGGEST_PADDING, SUGGEST_ROW_HEIGHT } from '../shared/types.ts'
import { conceal, isAddress, isNewTabUrl, prettyUrl, reveal } from './browser-url.ts'

// The address field's dropdown. The rows come from the pages visited before and from Google's
// search suggestions; they are shown in a small view of their own stacked above the page,
// because the page is a native view and nothing in the UI's own page can be drawn over it.
// Keyboard focus stays in the address field throughout: the UI moves the selection and this
// view only draws it, and reports a click.

const HISTORY_LIMIT = 3000
const VISITED_ROWS = 4
const SEARCH_ROWS = 4

type Visit = { url: string; title: string; visits: number; last: number }

class History {
  private readonly file = join(app.getPath('userData'), 'browser-history.json')
  private visited: Map<string, Visit> | null = null
  private timer: NodeJS.Timeout | null = null

  private entries(): Map<string, Visit> {
    if (this.visited) return this.visited
    this.visited = new Map()
    try {
      for (const visit of JSON.parse(readFileSync(this.file, 'utf8')) as Visit[]) {
        if (typeof visit?.url === 'string') this.visited.set(visit.url, visit)
      }
    } catch {
      // No history yet, or an unreadable file: start empty.
    }
    return this.visited
  }

  visit(url: string, title: string): void {
    if (!/^https?:/i.test(url) || isNewTabUrl(url)) return
    const entries = this.entries()
    const known = entries.get(url)
    entries.set(url, { url, title: title || known?.title || '', visits: (known?.visits ?? 0) + 1, last: Date.now() })
    this.changed()
  }

  setTitle(url: string, title: string): void {
    const known = this.entries().get(url)
    if (!known || !title || known.title === title) return
    known.title = title
    this.changed()
  }

  /** The visited pages that contain every typed word, best first. */
  match(text: string, limit: number): Visit[] {
    const typed = text.toLowerCase()
    const words = typed.split(/\s+/).filter(Boolean)
    const now = Date.now()
    const scored: Array<{ visit: Visit; score: number }> = []
    for (const visit of this.entries().values()) {
      const address = prettyUrl(visit.url).toLowerCase()
      const haystack = `${address} ${visit.title.toLowerCase()}`
      if (!words.every((word) => haystack.includes(word))) continue
      const days = (now - visit.last) / 86_400_000
      const score = Math.log2(1 + visit.visits) + (address.startsWith(typed) ? 10 : 0) + Math.max(0, 3 - days / 10) - address.length / 200
      scored.push({ visit, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.visit)
  }

  private changed(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null
      void writeFile(this.file, this.serialize()).catch(() => {})
    }, 2_000)
  }

  private serialize(): string {
    const entries = this.entries()
    if (entries.size > HISTORY_LIMIT) {
      const kept = [...entries.values()].sort((a, b) => b.last - a.last).slice(0, HISTORY_LIMIT)
      this.visited = new Map(kept.map((visit) => [visit.url, visit]))
    }
    return JSON.stringify([...this.entries().values()])
  }

  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      writeFileSync(this.file, this.serialize())
    } catch {
      // History is a convenience; losing the last few visits is fine.
    }
  }
}

async function searchSuggestions(text: string): Promise<string[]> {
  try {
    const response = await net.fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(2_000) }
    )
    const body = (await response.json()) as unknown
    const words = Array.isArray(body) ? body[1] : null
    return Array.isArray(words) ? words.filter((word): word is string => typeof word === 'string') : []
  } catch {
    return []
  }
}

const NONE: SuggestionList = { items: [], selected: -1 }

export class Suggestions {
  readonly history = new History()
  private view: WebContentsView | null = null
  private loaded = false
  private list = NONE
  private anchor: Bounds | null = null
  private request = 0
  /** The last search suggestions shown, kept on screen while the next ones are fetched. */
  private searches: string[] = []

  constructor(private readonly window: BrowserWindow) {
    window.on('resize', () => this.hide())
  }

  owns(sender: WebContents): boolean {
    return sender === this.view?.webContents
  }

  query(text: string, anchor: Bounds): void {
    const typed = text.trim()
    if (!typed) {
      this.hide()
      return
    }
    this.anchor = anchor
    const request = ++this.request
    const address = isAddress(typed)
    const local: Suggestion[] = [
      address
        ? { kind: 'url', value: typed, title: typed, detail: 'Open page' }
        : { kind: 'search', value: typed, title: typed, detail: 'Google Search' },
      ...this.history.match(typed, VISITED_ROWS).map((visit): Suggestion => ({
        kind: 'history', value: visit.url, title: visit.title || prettyUrl(visit.url), detail: prettyUrl(visit.url)
      }))
    ]
    const withSearches = (words: string[]): Suggestion[] => [
      ...local,
      ...words
        .filter((word) => word.toLowerCase() !== typed.toLowerCase())
        .slice(0, SEARCH_ROWS)
        .map((word): Suggestion => ({ kind: 'search', value: word, title: word, detail: 'Google Search' }))
    ]
    // What is typed as an address is not sent anywhere.
    if (address) this.searches = []
    else this.searches = this.searches.filter((word) => word.toLowerCase().startsWith(typed.toLowerCase()))
    this.show({ items: withSearches(this.searches), selected: -1 })
    if (address) return
    void searchSuggestions(typed).then((words) => {
      if (request !== this.request) return
      this.searches = words
      this.show({ items: withSearches(words), selected: this.list.selected })
    })
  }

  select(index: number): void {
    if (!this.list.items.length) return
    this.list = { ...this.list, selected: index }
    if (this.loaded) this.view?.webContents.send('rocket:browser-suggestions', this.list)
  }

  hide(): void {
    this.request++
    if (!this.list.items.length) return
    this.list = NONE
    this.searches = []
    if (this.view) conceal(this.window, this.view)
    this.window.webContents.send('rocket:browser-suggestions', NONE)
  }

  /** Put the dropdown's view back above a tab's view that was just added to the window. */
  raise(): void {
    if (this.view) this.window.contentView.addChildView(this.view)
  }

  dispose(): void {
    this.history.flush()
    this.view?.webContents.close()
  }

  private show(list: SuggestionList): void {
    if (!this.anchor || this.window.isDestroyed()) return
    this.list = list.selected < list.items.length ? list : { ...list, selected: -1 }
    const view = this.ensureView()
    this.window.webContents.send('rocket:browser-suggestions', this.list)
    if (this.loaded) view.webContents.send('rocket:browser-suggestions', this.list)
    const [windowWidth, windowHeight] = this.window.getContentSize()
    const width = Math.min(Math.max(this.anchor.width, 300), windowWidth - 16)
    const x = Math.min(Math.max(8, this.anchor.x + (this.anchor.width - width) / 2), windowWidth - width - 8)
    const y = this.anchor.y + this.anchor.height + 6
    const height = Math.min(SUGGEST_PADDING * 2 + this.list.items.length * SUGGEST_ROW_HEIGHT, windowHeight - y - 8)
    reveal(view, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // As for the window: an ESM preload cannot run sandboxed, and this loads only the app's own page.
        sandbox: false
      }
    })
    view.setBorderRadius(10)
    view.setBackgroundColor('#1b1c1e')
    this.view = view
    this.window.contentView.addChildView(view)
    view.webContents.on('did-finish-load', () => {
      this.loaded = true
      view.webContents.send('rocket:browser-suggestions', this.list)
    })
    if (process.env.ELECTRON_RENDERER_URL) void view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/suggest.html`)
    else void view.webContents.loadFile(join(import.meta.dirname, '../renderer/suggest.html'))
    return view
  }
}
