import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { isFileAttachment, type Attachment, type BrowserDownload, type Turn } from '../shared/types.ts'
import { kindOf, type LibraryEntry, type LibraryKind, type LibraryPreview, type LibrarySource, type LibraryView } from '../shared/library.ts'
import { decodeText, type AttachmentStore } from './attachments.ts'
import { repoRoot } from './git.ts'
import type { Store } from './store.ts'

// The library's index and previews (docs/library-plan.md, slice 1). Entries come from four
// places: attachments a chat sent (read live from the store, so nothing is copied twice), and
// files on disk the store records by path: a model's downloads, Markdown files a turn wrote, and
// files opened from a chat. Nothing else on the disk is ever listed.
//
// Previews are made by the same outside tools the attachments use (poppler for PDFs, ImageMagick
// for pictures, unzip for an Office file's own thumbnail), cached by path, size and time, and at
// most two are made at once so a full shelf never stalls the host. A tool that is missing only
// costs the picture: the card falls back to its type mark.

const run = promisify(execFile)
const PREVIEW_WIDTH = 480
const PREVIEW_TEXT = 3_000
const VIEW_TEXT = 200_000
const VIEW_PAGES = 12
const MAX_INLINE_IMAGE = 15 * 1024 * 1024
const MAX_UNCONVERTED_PREVIEW = 2 * 1024 * 1024
const PREVIEW_SLOTS = 2

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml'
}

export type LibraryOptions = {
  /** The shelf changed; the window reads it again. */
  changed: () => void
  /** A chat's browser downloads since a time, from main. */
  downloads: (chatId: string, since: number) => Promise<BrowserDownload[]>
  /** Folders whose files are never shelved: worktrees are deleted when their task ends, so a path in one would soon be missing. */
  skipRoots?: () => string[]
}

export class Library {
  private slots = PREVIEW_SLOTS
  private readonly waiting: Array<() => void> = []
  private readonly previews = new Map<string, Promise<LibraryPreview>>()

  constructor(private readonly store: Store, private readonly attachments: AttachmentStore, private readonly cacheDir: string, private readonly options: LibraryOptions) {}

  /** Every entry, newest first. */
  list(): LibraryEntry[] {
    const entries: LibraryEntry[] = []
    for (const { attachment, chatId, addedAt } of this.store.sentAttachments()) {
      const entry = this.attachmentEntry(attachment, chatId, addedAt)
      if (entry) entries.push(entry)
    }
    for (const file of this.store.libraryFiles()) {
      entries.push({
        id: `f${file.seq}`, name: file.name, kind: file.kind as LibraryKind, source: file.source as LibrarySource, origin: file.origin,
        chatId: file.chatId, path: file.path, size: file.size, addedAt: file.addedAt, missing: !existsSync(file.path)
      })
    }
    return entries.sort((a, b) => b.addedAt - a.addedAt)
  }

  entry(id: string): LibraryEntry {
    const found = this.list().find((each) => each.id === id)
    if (!found) throw new Error(`There is no library file "${id}". List the library again for current ids.`)
    return found
  }

  /** Put a file on the shelf by its path. Returns null for something that is not a readable file. */
  async add(path: string, source: LibrarySource, chatId: string | null, origin?: string, addedAt = Date.now()): Promise<LibraryEntry | null> {
    if (typeof path !== 'string' || !isAbsolute(path)) return null
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const name = basename(path)
    const row = this.store.addLibraryFile({
      path, name, kind: await sniffKind(path, name), source, origin: origin ?? basename(dirname(path)), chatId, size: info.size, addedAt
    })
    this.options.changed()
    return { id: `f${row.seq}`, name: row.name, kind: row.kind as LibraryKind, source: row.source as LibrarySource, origin: row.origin, chatId: row.chatId, path, size: row.size, addedAt: row.addedAt, missing: false }
  }

  /**
   * A turn ended: its finished downloads and the Markdown files it wrote join the shelf. `changed`
   * are the turn's files relative to its repository, as `Teamwork.turnEnded` reports them.
   */
  async turnEnded(turn: Turn, changed: string[]): Promise<void> {
    const chat = this.store.chat(turn.chatId)
    if (!chat) return
    const downloads = await this.options.downloads(chat.id, turn.startedAt).catch(() => [] as BrowserDownload[])
    for (const download of downloads) {
      if (download.state === 'completed') await this.add(download.path, 'download', chat.id, hostOf(download.url))
    }
    await this.addPlans(chat.id, chat.cwd, changed, Date.now())
  }

  /**
   * Once, on the first start with a library: the Markdown files that turns before it wrote, read
   * from the patches the store kept. Newest turns come first, so a file written several times is
   * dated by, and belongs to the chat of, the turn that last wrote it. Files since deleted or moved
   * are skipped.
   */
  async backfill(): Promise<number> {
    if (this.store.libraryBackfilled()) return 0
    const before = this.store.libraryFiles().length
    for (const { chatId, cwd, endedAt, paths } of this.store.markdownWrittenByTurns()) {
      await this.addPlans(chatId, cwd, paths, endedAt, true)
    }
    this.store.setLibraryBackfilled()
    return this.store.libraryFiles().length - before
  }

  private async addPlans(chatId: string, cwd: string, changed: string[], addedAt: number, quiet = false): Promise<void> {
    const plans = changed.filter((path) => kindOf(path) === 'markdown')
    if (!plans.length) return
    const top = await repoRoot(cwd)
    if (!top) return
    for (const path of plans) {
      const full = isAbsolute(path) ? path : join(top, path)
      if (this.skipped(full)) continue
      if (quiet && !existsSync(full)) continue
      await this.add(full, 'plan', chatId, relative(top, dirname(full)) || basename(top), addedAt)
    }
  }

  private skipped(path: string): boolean {
    return (this.options.skipRoots?.() ?? []).some((root) => {
      const inside = relative(root, path)
      return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    })
  }

  /** A card's picture or opening text; made once per version of the file and kept. */
  preview(id: string): Promise<LibraryPreview> {
    const entry = this.entry(id)
    if (entry.missing) return Promise.resolve({ type: 'none' })
    const key = `${entry.path}:${entry.size}`
    let made = this.previews.get(key)
    if (!made) {
      made = this.slot(() => this.makePreview(entry)).catch(() => ({ type: 'none' }) as LibraryPreview)
      this.previews.set(key, made)
    }
    return made
  }

  /** What the side panel shows when a file is opened from the library. */
  async view(id: string): Promise<LibraryView> {
    const entry = this.entry(id)
    if (entry.missing) return { type: 'none', reason: `${entry.name} is no longer at ${entry.path}. It may have been moved or deleted.` }
    if (entry.kind === 'markdown' || entry.kind === 'text') {
      const text = await readText(entry.path, VIEW_TEXT * 4)
      if (text === null) return { type: 'none', reason: `${entry.name} is not readable as text.` }
      return { type: 'text', text: text.slice(0, VIEW_TEXT), markdown: entry.kind === 'markdown', truncated: text.length > VIEW_TEXT }
    }
    if (entry.kind === 'pdf') {
      if (entry.attachmentId) {
        const preview = await this.attachments.preview(entry.attachmentId)
        if (preview.type === 'pdf') return preview
      }
      const folder = join(this.cacheDir, `${await this.fingerprint(entry)}.pages`)
      let names = await readdir(folder).catch(() => [] as string[])
      if (!names.length) {
        await mkdir(folder, { recursive: true })
        await poppler(['-jpeg', '-jpegopt', 'quality=80', '-scale-to', '1100', '-l', String(VIEW_PAGES), entry.path, join(folder, 'page')], entry.name)
        names = await readdir(folder)
      }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const pages = await Promise.all(names.map(async (name) => `data:image/jpeg;base64,${(await readFile(join(folder, name))).toString('base64')}`))
      return { type: 'pdf', pages, truncated: (entry.pages ?? await pageCount(entry.path)) > pages.length }
    }
    if (entry.kind === 'image') {
      if (entry.size > MAX_INLINE_IMAGE) return { type: 'none', reason: `${entry.name} is larger than 15 MB, too large to show here. Open it from ${dirname(entry.path)}.` }
      const mime = IMAGE_MIME[extensionOf(entry.path)] ?? 'image/png'
      return { type: 'image', src: `data:${mime};base64,${(await readFile(entry.path)).toString('base64')}` }
    }
    return { type: 'none', reason: `Craft Studio cannot show ${entry.kind === 'office' ? 'Office files' : 'this kind of file'} yet. It is at ${entry.path}.` }
  }

  private attachmentEntry(attachment: Attachment, chatId: string, addedAt: number): LibraryEntry | null {
    let path: string
    try { path = this.attachments.resolve([attachment.id])[0]!.path } catch { return null }
    const common = { id: attachment.id, attachmentId: attachment.id, name: attachment.name, source: 'attachment' as const, origin: 'attachment', chatId, path, size: attachment.size, addedAt, missing: !existsSync(path) }
    if (!isFileAttachment(attachment)) return { ...common, kind: 'image', width: attachment.width, height: attachment.height }
    if (attachment.format === 'pdf') return { ...common, kind: 'pdf', pages: attachment.pages }
    return { ...common, kind: kindOf(attachment.name) === 'markdown' ? 'markdown' : 'text' }
  }

  private async makePreview(entry: LibraryEntry): Promise<LibraryPreview> {
    if (entry.kind === 'markdown' || entry.kind === 'text') {
      const text = await readText(entry.path, PREVIEW_TEXT * 4)
      return text === null ? { type: 'none' } : { type: 'text', text: text.slice(0, PREVIEW_TEXT), markdown: entry.kind === 'markdown' }
    }
    if (entry.kind === 'image' && entry.attachmentId) return { type: 'image', src: await this.attachments.read(entry.attachmentId, true) }
    const out = join(this.cacheDir, `${await this.fingerprint(entry)}.jpg`)
    const cached = await readFile(out).catch(() => null)
    if (cached) return picture(entry, cached)
    await mkdir(this.cacheDir, { recursive: true })
    if (entry.kind === 'pdf') {
      await poppler(['-singlefile', '-f', '1', '-l', '1', '-hide-annotations', '-scale-to', String(PREVIEW_WIDTH), '-jpeg', '-jpegopt', 'quality=82', entry.path, out.slice(0, -4)], entry.name)
      return picture(entry, await readFile(out))
    }
    if (entry.kind === 'image') {
      try {
        await run('convert', [`${entry.path}[0]`, '-auto-orient', '-thumbnail', `${PREVIEW_WIDTH}x${PREVIEW_WIDTH}>`, '-quality', '82', out], { timeout: 30_000 })
        return picture(entry, await readFile(out))
      } catch {
        // Without ImageMagick a small picture is its own preview; a large one shows its type mark.
        if (entry.size > MAX_UNCONVERTED_PREVIEW) return { type: 'none' }
        const mime = IMAGE_MIME[extensionOf(entry.path)] ?? 'image/png'
        return { type: 'image', src: `data:${mime};base64,${(await readFile(entry.path)).toString('base64')}` }
      }
    }
    if (entry.kind === 'office') {
      // Office files saved with a preview carry it in the zip; many do not, and then there is none.
      const { stdout } = await run('unzip', ['-p', entry.path, 'docProps/thumbnail.jpeg'], { encoding: 'buffer', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
      const bytes = stdout as unknown as Buffer
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 ? { type: 'image', src: `data:image/jpeg;base64,${bytes.toString('base64')}` } : { type: 'none' }
    }
    return { type: 'none' }
  }

  /** The cache name of a file's version: its path, size and modification time. */
  private async fingerprint(entry: LibraryEntry): Promise<string> {
    const info = await stat(entry.path)
    return createHash('sha1').update(`${entry.path}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 20)
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.slots === 0) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.slots--
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.slots++
    }
  }
}

function picture(entry: LibraryEntry, bytes: Buffer): LibraryPreview {
  return { type: entry.kind === 'pdf' ? 'page' : 'image', src: `data:image/jpeg;base64,${bytes.toString('base64')}` }
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function hostOf(url: string): string {
  try { return new URL(url).host || 'download' } catch { return 'download' }
}

/** A PDF is a PDF by its bytes, whatever it is called; anything else goes by its name. */
async function sniffKind(path: string, name: string): Promise<LibraryKind> {
  const kind = kindOf(name)
  if (kind !== 'other' && kind !== 'text') return kind
  const head = await readHead(path, 1028)
  if (head?.subarray(0, 1024).includes('%PDF-')) return 'pdf'
  if (kind === 'other' && head?.length && decodeStart(head, 1024) !== null) return 'text'
  return kind
}

async function readHead(path: string, bytes: number): Promise<Buffer | null> {
  const file = await open(path, 'r').catch(() => null)
  if (!file) return null
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await file.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function readText(path: string, max: number): Promise<string | null> {
  const bytes = await readHead(path, max + 4)
  return bytes ? decodeStart(bytes, max) : null
}

/** The start of a file as text, or null for binary; a cut through a multi-byte character is backed off. */
function decodeStart(bytes: Buffer, max: number): string | null {
  if (bytes.length <= max) return decodeText(bytes)
  for (let end = max; end > max - 4; end--) {
    const text = decodeText(bytes.subarray(0, end))
    if (text !== null) return text
  }
  return null
}

async function pageCount(path: string): Promise<number> {
  try {
    const { stdout } = await run('pdfinfo', [path], { timeout: 15_000 })
    return Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]) || 0
  } catch {
    return 0
  }
}

async function poppler(args: string[], name: string): Promise<void> {
  try {
    await run('pdftoppm', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Craft Studio reads PDFs with poppler-utils. Install it (sudo apt install poppler-utils), then open the file again.')
    throw new Error(`${name} could not be read as a PDF. It may be damaged or password protected.`)
  }
}
