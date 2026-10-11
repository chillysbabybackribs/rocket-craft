// The library: one shelf for every file a chat touched (docs/library-plan.md). The host builds
// the entries; the panel and the `library_list` tool filter them with the same function here, so
// what a model lists and what the user sees under the same filters are one answer.

export type LibraryKind = 'pdf' | 'markdown' | 'text' | 'image' | 'office' | 'other'
/**
 * Where a file came from: attached in a chat, downloaded by a model's browsing, a Markdown file a
 * turn wrote, a file opened from a chat, or a picture a model made (Codex's image generation).
 */
export type LibrarySource = 'attachment' | 'download' | 'plan' | 'opened' | 'generated'
export type LibraryAdded = 'today' | 'yesterday' | 'week' | 'older'

export type LibraryEntry = {
  /** An attachment keeps its attachment id; a file on disk is `f<n>`. */
  id: string
  name: string
  kind: LibraryKind
  source: LibrarySource
  /** A download's host name, a plan's folder, the provider that made a picture, or "attachment". */
  origin: string
  chatId: string | null
  /** Absolute path on disk. */
  path: string
  size: number
  addedAt: number
  /** The file is no longer at `path`. */
  missing: boolean
  pages?: number
  width?: number
  height?: number
  /** For an attachment: so the panel can open it as an attachment. */
  attachmentId?: string
}

export type LibraryFilters = {
  source?: LibrarySource
  kind?: LibraryKind
  chat?: string
  added?: LibraryAdded
  q?: string
}

/** What a card shows: a rendered first page or picture, the start of a text, or nothing to show. */
export type LibraryPreview =
  | { type: 'image'; src: string }
  | { type: 'page'; src: string }
  | { type: 'text'; text: string; markdown: boolean }
  | { type: 'none' }

/** What the side panel shows when a library file is opened in it. */
export type LibraryView =
  | { type: 'text'; text: string; markdown: boolean; truncated: boolean }
  | { type: 'pdf'; pages: string[]; truncated: boolean }
  | { type: 'image'; src: string }
  | { type: 'none'; reason: string }

export const LIBRARY_SOURCES: ReadonlyArray<[LibrarySource, string]> = [
  ['attachment', 'Attachments'], ['download', 'Downloads'], ['plan', 'Plans'], ['opened', 'Opened from chat'], ['generated', 'Made by a model']
]
export const LIBRARY_KINDS: ReadonlyArray<[LibraryKind, string]> = [
  ['pdf', 'PDF'], ['markdown', 'Markdown'], ['text', 'Text and code'], ['image', 'Images'], ['office', 'Office'], ['other', 'Other']
]
export const LIBRARY_ADDED: ReadonlyArray<[LibraryAdded, string]> = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['older', 'Older']
]

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|key|pages|numbers)$/i
const TEXT = /\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|s[ac]ss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|r|lua|pl|vue|svelte)$/i

/** A file's kind from its name; the host checks a PDF's bytes as well. */
export function kindOf(name: string): LibraryKind {
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.(md|markdown|mdx)$/i.test(name)) return 'markdown'
  if (IMAGE.test(name)) return 'image'
  if (OFFICE.test(name)) return 'office'
  if (TEXT.test(name)) return 'text'
  return 'other'
}

const DAY = 24 * 60 * 60 * 1000

/** Which of the "Added" buckets a time falls in, by the local calendar. */
export function addedBucket(at: number, now = Date.now()): LibraryAdded {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  if (at >= today) return 'today'
  if (at >= today - DAY) return 'yesterday'
  if (at >= today - 6 * DAY) return 'week'
  return 'older'
}

/** `chatTitle` lets search match the chat a file came from. */
export function matchesFilters(entry: LibraryEntry, filters: LibraryFilters, chatTitle: (chatId: string) => string = () => '', now = Date.now()): boolean {
  if (filters.source && entry.source !== filters.source) return false
  if (filters.kind && entry.kind !== filters.kind) return false
  if (filters.chat && entry.chatId !== filters.chat) return false
  if (filters.added && addedBucket(entry.addedAt, now) !== filters.added) return false
  const q = filters.q?.trim().toLowerCase()
  if (!q) return true
  const haystack = [entry.name, entry.origin, entry.path, entry.chatId ? chatTitle(entry.chatId) : ''].join('\n').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

export function filterEntries(entries: LibraryEntry[], filters: LibraryFilters, chatTitle?: (chatId: string) => string, now = Date.now()): LibraryEntry[] {
  return entries.filter((entry) => matchesFilters(entry, filters, chatTitle, now))
}

/** Filters read from loose input (a tool's arguments, an app-map call), refusing unknown values with the valid ones. */
export function parseFilters(input: Record<string, unknown>): LibraryFilters {
  const pick = <T extends string>(name: string, options: ReadonlyArray<[T, string]>): T | undefined => {
    const value = input[name]
    if (value === undefined || value === null || value === '' || value === 'any') return undefined
    const found = options.find(([id]) => id === value)
    if (!found) throw new Error(`${name} is one of ${options.map(([id]) => id).join(', ')}, or leave it out for any.`)
    return found[0]
  }
  const filters: LibraryFilters = {
    source: pick('source', LIBRARY_SOURCES),
    kind: pick('kind', LIBRARY_KINDS),
    added: pick('added', LIBRARY_ADDED)
  }
  if (typeof input.chat === 'string' && input.chat) filters.chat = input.chat
  if (typeof input.q === 'string' && input.q.trim()) filters.q = input.q.trim()
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as LibraryFilters
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
