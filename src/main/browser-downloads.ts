import { app, type DownloadItem, type Session, type WebContents } from 'electron'
import { existsSync, statSync } from 'node:fs'
import type { BrowserDownload } from '../shared/types.ts'
import { downloadTarget, uniquePath } from './download-path.ts'

// Downloads in the browser that a model causes are saved without a dialog. Electron shows its
// save dialog whenever `will-download` does not call `item.setSavePath` (DownloadItem docs,
// checked 2026-10-06), and a model cannot answer a native dialog, so it stalled there.
//
// A download is a model's when its page is one a model is working in during a turn (its own tab,
// or a tab it touched), or when `browser_download` asked for it. Those go to the user's downloads
// folder, or where the model said, never over an existing file. Downloads the user starts in a
// tab no model is using keep Chromium's usual save dialog.

type Expected = { chat: string; saveTo: string | null; url: string | null; take: (record: Entry) => void }
type Entry = BrowserDownload & { contents: WebContents | null; done: Promise<void> }

const KEEP = 50

export class BrowserDownloads {
  private readonly entries: Entry[] = []
  private readonly expected = new Map<WebContents, Expected>()
  private readonly arriving = new Set<string>()
  private seq = 0

  /** `owner` names the chat whose turn is working in a page, or null when only the user is. */
  private readonly listener = (_event: Electron.Event, item: DownloadItem, contents: WebContents | undefined): void => this.start(item, contents ?? null)

  constructor(private readonly session: Session, private readonly owner: (contents: WebContents) => string | null) {
    session.on('will-download', this.listener)
  }

  /** The window closed: the session outlives it, so the listener must not. */
  dispose(): void {
    this.session.off('will-download', this.listener)
  }

  /**
   * The next download `contents` starts is `chat`'s, saved to `saveTo` (an absolute folder or
   * file, or null for the downloads folder). Resolves with it, or null if none starts in time.
   */
  expect(contents: WebContents, chat: string, saveTo: string | null, url: string | null, timeoutMs: number): Promise<Entry | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.expected.get(contents)?.take === take) this.expected.delete(contents); resolve(null) }, timeoutMs)
      const take = (entry: Entry): void => { clearTimeout(timer); resolve(entry) }
      this.expected.set(contents, { chat, saveTo, url, take })
    })
  }

  /** A chat's downloads that started at or after `since`, newest last. */
  since(chat: string, since: number): BrowserDownload[] {
    return this.entries.filter((entry) => entry.chat === chat && entry.startedAt >= since).map(publicOf)
  }

  /** Wait for a download to end, or for `ms` to pass; either way say where it stands. */
  async settle(entry: Entry, ms: number): Promise<BrowserDownload> {
    await Promise.race([entry.done, new Promise((resolve) => setTimeout(resolve, ms))])
    return publicOf(entry)
  }

  private start(item: DownloadItem, contents: WebContents | null): void {
    // A download asked for by URL may arrive without its page; it is matched by address instead.
    const wanted = contents ? this.expected.get(contents) : [...this.expected.values()].find((each) => each.url === item.getURL())
    const chat = wanted?.chat ?? (contents ? this.owner(contents) : null)
    if (chat === null) return
    if (wanted) for (const [key, value] of this.expected) if (value === wanted) this.expected.delete(key)
    const target = downloadTarget(wanted?.saveTo ?? null, item.getFilename(), app.getPath('downloads'),
      (path) => existsSync(path) && statSync(path).isDirectory())
    const path = uniquePath(target, (candidate) => existsSync(candidate) || this.arriving.has(candidate))
    item.setSavePath(path)
    this.arriving.add(path)
    let finish = (): void => {}
    const entry: Entry = {
      id: `d${++this.seq}`, chat, url: item.getURL(), name: path.split('/').pop() ?? item.getFilename(), path,
      mime: item.getMimeType(), size: item.getTotalBytes(), received: 0, state: 'progressing', startedAt: Date.now(),
      contents, done: new Promise((resolve) => { finish = resolve })
    }
    item.on('updated', (_event, state) => {
      entry.received = item.getReceivedBytes()
      entry.size = item.getTotalBytes()
      if (state === 'interrupted') entry.state = 'interrupted'
    })
    item.once('done', (_event, state) => {
      entry.received = item.getReceivedBytes()
      entry.size = item.getTotalBytes() || entry.received
      entry.state = state
      this.arriving.delete(path)
      finish()
    })
    this.entries.push(entry)
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP)
    wanted?.take(entry)
  }
}

function publicOf({ contents: _contents, done: _done, ...download }: Entry): BrowserDownload {
  return { ...download }
}
