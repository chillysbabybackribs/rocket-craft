import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, File, FileCode, FileImage, FileText, FileWarning, Folder, LayoutGrid, List, Presentation, Search, X } from 'lucide-react'
import {
  addedBucket, filterEntries, formatSize, LIBRARY_ADDED, LIBRARY_KINDS, LIBRARY_SOURCES,
  type LibraryEntry, type LibraryFilters, type LibraryKind, type LibraryPreview
} from '../../../shared/library.ts'
import { act, go } from '../app-map.ts'
import { loadLibrary, loadLibraryPreview, setLibraryOpen, useApp } from '../store.ts'

// The library beside the chat (docs/mockups/document-library.html, docs/library-plan.md): a
// filter rail, then every file the chats touched as a grid of real previews or a list. Filters and
// opening a file go through the app map, so a model and a click change the panel the same way.

const KIND_LABEL: Record<LibraryKind, string> = { pdf: 'PDF', markdown: 'MD', text: 'TXT', image: 'IMG', office: 'DOC', other: 'FILE' }
const SOURCE_LABEL: Record<LibraryEntry['source'], string> = { attachment: 'Attachment', download: 'Download', plan: 'Plan', opened: 'Opened' }

type FilterName = 'source' | 'kind' | 'chat' | 'added'
type Option = { value: string; label: string }

const titleOf = (chats: Array<{ id: string; title: string }>) => (chatId: string): string => chats.find((chat) => chat.id === chatId)?.title ?? ''

/** Set one filter and keep the rest, through the map as a model would. */
function setFilter(filters: LibraryFilters, name: keyof LibraryFilters, value: string | undefined): void {
  void go('library', { source: '', kind: '', chat: '', added: '', q: '', ...filters, [name]: value ?? '' })
}

export function LibraryPanel() {
  const library = useApp((state) => state.library)
  const chats = useApp((state) => state.chats)
  useEffect(() => { if (!library.loaded) void loadLibrary() }, [library.loaded])
  const title = useMemo(() => titleOf(chats), [chats])
  const shown = useMemo(() => filterEntries(library.entries, library.filters, title), [library.entries, library.filters, title])
  const filtered = Object.values(library.filters).some(Boolean)

  return (
    <aside className="library-panel" aria-label="Library">
      <FilterRail entries={library.entries} filters={library.filters} chatTitle={title} />
      <section className="lib-browse">
        <header className="lib-head">
          <h2>{filtered ? 'Filtered' : 'All files'}</h2>
          <span className="lib-count">{library.loaded ? `${shown.length} of ${library.entries.length}` : ''}</span>
          <span className="lib-spacer" />
          <SearchBox filters={library.filters} />
          <div className="lib-seg" role="group" aria-label="View">
            <button type="button" aria-label="Grid" title="Grid" aria-pressed={library.view === 'grid'} onClick={() => void go('library', { view: 'grid' })}><LayoutGrid size={14} /></button>
            <button type="button" aria-label="List" title="List" aria-pressed={library.view === 'list'} onClick={() => void go('library', { view: 'list' })}><List size={14} /></button>
          </div>
          <button type="button" className="icon-button" aria-label="Close library" title="Close library" onClick={() => setLibraryOpen(false)}><X size={15} /></button>
        </header>
        {filtered && <Chips filters={library.filters} chatTitle={title} />}
        <div className="lib-scroll">
          {library.error ? <p className="lib-empty" role="alert">{library.error}</p>
            : !library.loaded ? <p className="lib-empty">Reading the library…</p>
            : !library.entries.length ? (
              <div className="lib-empty">
                <b>Nothing on the shelf yet</b>
                <span>Files you attach, files a model downloads, plans a turn writes and files opened from a chat all appear here.</span>
              </div>
            ) : !shown.length ? (
              <div className="lib-empty">
                <b>No files match these filters</b>
                <button type="button" className="text-button" onClick={() => void act('library.clear')}>Clear filters</button>
              </div>
            ) : library.view === 'list' ? <ListView entries={shown} selected={library.selected} chatTitle={title} />
              : <div className="lib-grid">{shown.map((entry) => <Card key={entry.id} entry={entry} selected={entry.id === library.selected} chatTitle={title} />)}</div>}
        </div>
      </section>
    </aside>
  )
}

function FilterRail({ entries, filters, chatTitle }: { entries: LibraryEntry[]; filters: LibraryFilters; chatTitle: (chatId: string) => string }) {
  const [open, setOpen] = useState<FilterName | null>(null)
  const rail = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rail.current?.contains(event.target as Node)) setOpen(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close) }
  }, [open])

  // Each count is what choosing that option would show, given the other filters.
  const count = (name: FilterName, value: string): number => filterEntries(entries, { ...filters, [name]: value }, chatTitle).length
  const chatsHere = [...new Set(entries.map((entry) => entry.chatId).filter((id): id is string => id !== null))]
  const fields: Array<{ name: FilterName; label: string; any: string; options: Option[] }> = [
    { name: 'source', label: 'Source', any: 'All sources', options: LIBRARY_SOURCES.map(([value, label]) => ({ value, label })) },
    { name: 'kind', label: 'Kind', any: 'All kinds', options: LIBRARY_KINDS.map(([value, label]) => ({ value, label })) },
    { name: 'chat', label: 'Chat', any: 'Any chat', options: chatsHere.map((id) => ({ value: id, label: chatTitle(id) || 'Deleted chat' })) },
    { name: 'added', label: 'Added', any: 'Any time', options: LIBRARY_ADDED.map(([value, label]) => ({ value, label })) }
  ]
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  const filtered = Object.values(filters).some(Boolean)

  return (
    <nav className="lib-filters" ref={rail} aria-label="Library filters">
      <div className="lib-scope"><Folder size={15} />All files</div>
      {fields.map((field) => {
        const value = filters[field.name]
        const chosen = field.options.find((option) => option.value === value)
        const without = filterEntries(entries, { ...filters, [field.name]: undefined }, chatTitle).length
        return (
          <div className="lib-field" key={field.name}>
            <span className="lib-label" id={`lib-${field.name}`}>{field.label}</span>
            <button type="button" className={`lib-select${value ? ' is-set' : ''}`} aria-haspopup="listbox" aria-expanded={open === field.name} aria-labelledby={`lib-${field.name}`}
              onClick={() => setOpen(open === field.name ? null : field.name)}>
              <span>{chosen?.label ?? field.any}</span><ChevronDown size={13} />
            </button>
            {open === field.name && (
              <div className="lib-menu" role="listbox" aria-label={field.label}>
                <button type="button" role="option" aria-selected={!value} onClick={() => { setOpen(null); setFilter(filters, field.name, undefined) }}>
                  <span className="lib-tick">{!value && <Check size={13} />}</span>{field.any}<span className="lib-n">{without}</span>
                </button>
                {field.options.map((option) => (
                  <button key={option.value} type="button" role="option" aria-selected={value === option.value} onClick={() => { setOpen(null); setFilter(filters, field.name, option.value) }}>
                    <span className="lib-tick">{value === option.value && <Check size={13} />}</span><span className="lib-opt">{option.label}</span><span className="lib-n">{count(field.name, option.value)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <button type="button" className="lib-clear" disabled={!filtered} onClick={() => void act('library.clear')}>Clear filters</button>
      <div className="lib-foot">{entries.length} {entries.length === 1 ? 'file' : 'files'} · {formatSize(total)}<br />Chats' attachments, downloads, plans and opened files only.</div>
    </nav>
  )
}

function SearchBox({ filters }: { filters: LibraryFilters }) {
  const [text, setText] = useState(filters.q ?? '')
  const typed = useRef(filters.q ?? '')
  // A model's search shows in the box; the user's typing waits a moment before it filters.
  useEffect(() => { if ((filters.q ?? '') !== typed.current) { typed.current = filters.q ?? ''; setText(filters.q ?? '') } }, [filters.q])
  useEffect(() => {
    if (text === typed.current) return
    const timer = setTimeout(() => { typed.current = text; setFilter(filters, 'q', text.trim() || undefined) }, 200)
    return () => clearTimeout(timer)
  }, [text, filters])
  return (
    <label className="lib-search">
      <Search size={13} />
      <input value={text} placeholder="Search names, folders, chats" aria-label="Search the library" onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && text) { event.stopPropagation(); setText('') } }} />
    </label>
  )
}

function Chips({ filters, chatTitle }: { filters: LibraryFilters; chatTitle: (chatId: string) => string }) {
  const label = (name: keyof LibraryFilters, value: string): string => {
    if (name === 'source') return LIBRARY_SOURCES.find(([id]) => id === value)?.[1] ?? value
    if (name === 'kind') return LIBRARY_KINDS.find(([id]) => id === value)?.[1] ?? value
    if (name === 'added') return LIBRARY_ADDED.find(([id]) => id === value)?.[1] ?? value
    if (name === 'chat') return chatTitle(value) || 'Deleted chat'
    return `“${value}”`
  }
  const names: Record<keyof LibraryFilters, string> = { source: 'Source', kind: 'Kind', chat: 'Chat', added: 'Added', q: 'Search' }
  return (
    <div className="lib-chips">
      {(Object.entries(filters) as Array<[keyof LibraryFilters, string]>).filter(([, value]) => value).map(([name, value]) => (
        <span className="lib-chip" key={name}>
          <span>{names[name]}</span>{label(name, value)}
          <button type="button" aria-label={`Remove the ${names[name].toLowerCase()} filter`} onClick={() => setFilter(filters, name, undefined)}><X size={11} /></button>
        </span>
      ))}
    </div>
  )
}

/** Ask for the picture only once the card is near the screen. */
function usePreview(entry: LibraryEntry): [React.RefObject<HTMLElement | null>, LibraryPreview | null | undefined] {
  const preview = useApp((state) => state.library.previews[entry.id])
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (preview !== undefined || !ref.current) return
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((each) => each.isIntersecting)) { observer.disconnect(); void loadLibraryPreview(entry.id) }
    }, { rootMargin: '300px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [entry.id, preview])
  return [ref, preview]
}

function KindMark({ entry, size = 22 }: { entry: LibraryEntry; size?: number }) {
  if (entry.missing) return <FileWarning size={size} />
  if (entry.kind === 'image') return <FileImage size={size} />
  if (entry.kind === 'markdown' || entry.kind === 'pdf') return <FileText size={size} />
  if (entry.kind === 'text') return <FileCode size={size} />
  if (entry.kind === 'office') return <Presentation size={size} />
  return <File size={size} />
}

function Thumb({ entry, preview }: { entry: LibraryEntry; preview: LibraryPreview | null | undefined }) {
  if (preview?.type === 'image') return <div className="lib-thumb is-cover"><img src={preview.src} alt="" draggable={false} /></div>
  if (preview?.type === 'page') return <div className="lib-thumb is-page"><img src={preview.src} alt="" draggable={false} /></div>
  if (preview?.type === 'text') {
    return (
      <div className="lib-thumb is-page">
        <div className={`lib-text-page${preview.markdown ? ' is-markdown' : ''}`} aria-hidden>
          {preview.text.split('\n').slice(0, 40).map((line, index) => <div key={index} className={preview.markdown && /^#{1,6} /.test(line) ? 'is-heading' : undefined}>{preview.markdown ? line.replace(/^#{1,6} /, '').replace(/\*\*/g, '') : line || ' '}</div>)}
        </div>
      </div>
    )
  }
  return <div className={`lib-thumb is-mark${preview === undefined || preview === null ? ' is-loading' : ''}`}><KindMark entry={entry} /></div>
}

/** Where it came from: an attachment's chat, a download's site, a plan's folder. */
function subtitle(entry: LibraryEntry, chatTitle: (chatId: string) => string): string {
  const where = entry.source === 'attachment' ? (entry.chatId ? chatTitle(entry.chatId) : '') : entry.origin
  return where ? `${SOURCE_LABEL[entry.source]} · ${where}` : SOURCE_LABEL[entry.source]
}

function Card({ entry, selected, chatTitle }: { entry: LibraryEntry; selected: boolean; chatTitle: (chatId: string) => string }) {
  const [ref, preview] = usePreview(entry)
  return (
    <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className={`lib-card${selected ? ' is-selected' : ''}${entry.missing ? ' is-missing' : ''}`}
      title={entry.path} aria-label={`Open ${entry.name}`} onClick={() => void act('library.open', { id: entry.id })}>
      <span className="lib-frame">
        <Thumb entry={entry} preview={preview} />
        {entry.kind !== 'image' && <span className="lib-kind">{KIND_LABEL[entry.kind]}</span>}
        {entry.pages ? <span className="lib-pages">{entry.pages} pp</span> : null}
        {entry.missing && <span className="lib-missing">Missing</span>}
      </span>
      <span className="lib-name">{entry.name}</span>
      <span className="lib-sub">{subtitle(entry, chatTitle)}</span>
    </button>
  )
}

function ListRow({ entry, selected, chatTitle }: { entry: LibraryEntry; selected: boolean; chatTitle: (chatId: string) => string }) {
  const [ref, preview] = usePreview(entry)
  const added = new Date(entry.addedAt)
  const when = addedBucket(entry.addedAt) === 'today' ? added.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : added.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return (
    <tr ref={ref as React.RefObject<HTMLTableRowElement>} className={`${selected ? 'is-selected' : ''}${entry.missing ? ' is-missing' : ''}`} title={entry.path}>
      <td className="lib-cell-name">
        <button type="button" onClick={() => void act('library.open', { id: entry.id })}>
          <span className={`lib-mini${preview?.type === 'page' || preview?.type === 'text' ? ' is-page' : ''}`}>
            {preview?.type === 'image' || preview?.type === 'page' ? <img src={preview.src} alt="" /> : <KindMark entry={entry} size={14} />}
          </span>
          <span className="lib-row-name">{entry.name}</span>
        </button>
      </td>
      <td>{KIND_LABEL[entry.kind]}</td>
      <td>{entry.source === 'attachment' ? SOURCE_LABEL.attachment : subtitle(entry, chatTitle)}</td>
      <td className="lib-cell-chat">{entry.chatId ? chatTitle(entry.chatId) || 'Deleted chat' : '—'}</td>
      <td className="lib-num">{formatSize(entry.size)}</td>
      <td>{entry.missing ? 'Missing' : when}</td>
    </tr>
  )
}

function ListView({ entries, selected, chatTitle }: { entries: LibraryEntry[]; selected: string | null; chatTitle: (chatId: string) => string }) {
  return (
    <table className="lib-list">
      <thead><tr><th>Name</th><th>Kind</th><th>Source</th><th>Chat</th><th className="lib-num">Size</th><th>Added</th></tr></thead>
      <tbody>{entries.map((entry) => <ListRow key={entry.id} entry={entry} selected={entry.id === selected} chatTitle={chatTitle} />)}</tbody>
    </table>
  )
}
