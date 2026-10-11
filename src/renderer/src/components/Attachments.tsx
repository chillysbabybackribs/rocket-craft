import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import { isFileAttachment, type Attachment, type FileAttachment, type ImageAttachment } from '../../../shared/types.ts'
import { call } from '../host.ts'
import { ATTACHMENT_DRAG_TYPE } from '../drafts.ts'
import { openAttachment, useApp } from '../store.ts'
import { AttachmentMenu } from './AttachmentMenu.tsx'

type MenuRequest = { point: { x: number; y: number } | null; at: number } | null
/** Right-click, Shift+F10 or the context-menu key on a tile opens the same menu as its ⋯ button. */
function useMenuRequest() {
  const [request, setRequest] = useState<MenuRequest>(null)
  return {
    request,
    handlers: {
      onContextMenu: (event: MouseEvent) => { event.preventDefault(); setRequest({ point: { x: event.clientX, y: event.clientY }, at: Date.now() }) },
      onKeyDown: (event: KeyboardEvent) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); setRequest({ point: null, at: Date.now() }) }
      }
    }
  }
}

// Electron's native browser view must hide while a renderer dialog (an image preview, a capture) is open.
let previewOpen = false
const previewListeners = new Set<() => void>()
export function setPreviewOpen(open: boolean): void {
  previewOpen = open
  for (const notify of previewListeners) notify()
}
export function useImagePreviewOpen(): boolean {
  return useSyncExternalStore(listener => { previewListeners.add(listener); return () => { previewListeners.delete(listener) } }, () => previewOpen)
}

function ImageTile({ image, remove, fresh }: { image: ImageAttachment; remove?: () => void; fresh?: boolean }) {
  const menu = useMenuRequest()
  const [src, setSrc] = useState<string | null>(null)
  const [full, setFull] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let alive = true
    const element = dialog.current
    void call('attachment.read', { id: image.id, thumbnail: true }).then(value => { if (alive) setSrc(value) }, reason => { if (alive) setError(String(reason.message)) })
    return () => { alive = false; if (element?.open) setPreviewOpen(false) }
  }, [image.id])
  const enlarge = async (): Promise<void> => {
    setPreviewOpen(true)
    dialog.current?.showModal()
    try { setFull(await call('attachment.read', { id: image.id })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'This image could not be opened.') }
  }
  return (
    <div className={`image-attachment${fresh ? ' is-fresh' : ''}`} {...menu.handlers}>
      <button type="button" className="image-thumbnail" aria-label={`Preview ${image.name}`} onClick={() => void enlarge()} draggable
        onDragStart={event => { event.dataTransfer.setData(ATTACHMENT_DRAG_TYPE, JSON.stringify(image)); event.dataTransfer.effectAllowed = 'copy' }}>
        {src ? <img src={src} alt={image.name} draggable={false} /> : <span>{error ? 'Unavailable' : 'Loading…'}</span>}
      </button>
      <AttachmentMenu attachment={image} onPreview={() => void enlarge()} className="is-image" request={menu.request} />
      {remove && <button type="button" className="image-remove" aria-label={`Remove ${image.name}`} onClick={remove}><X size={12} /></button>}
      <span className="image-name" title={image.name}>{image.name}</span>
      <dialog ref={dialog} className="image-preview" aria-label={`Image preview: ${image.name}`} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }} onClose={() => { setFull(null); setPreviewOpen(false) }}>
        <div className="image-preview-bar"><span>{image.name}</span><button type="button" aria-label="Close image preview" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
        {full ? <img src={full} alt={image.name} /> : <p>{error ?? 'Loading image…'}</p>}
      </dialog>
    </div>
  )
}

const CODE = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'css', 'scss', 'html', 'xml', 'sh', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'sql', 'yml', 'yaml', 'toml', 'vue', 'svelte', 'lua']
const SHEET = ['csv', 'tsv', 'xls', 'xlsx']
const MARK_COLORS = { pdf: '#d75a59', code: '#5086cf', image: '#9470ca', sheet: '#399779', text: '#788598' }

export function extensionLabel(file: FileAttachment): string {
  if (file.format === 'pdf') return 'PDF'
  const ext = file.name.includes('.') ? file.name.split('.').at(-1)!.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : ''
  return ext || 'TXT'
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function fileMeta(file: FileAttachment): string {
  const pages = file.format === 'pdf' && file.pages ? `${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : null
  return [extensionLabel(file), pages, fileSize(file.size)].filter(Boolean).join(' · ')
}

/** A solid document with a folded corner, a symbol for its kind and its extension, as agreed in docs/mockups/file-attachments.html. */
export function FileMark({ file, small }: { file: FileAttachment; small?: boolean }) {
  const ext = extensionLabel(file)
  const lower = ext.toLowerCase()
  const type = ext === 'PDF' ? 'pdf' : SHEET.includes(lower) ? 'sheet' : lower === 'svg' ? 'image' : CODE.includes(lower) ? 'code' : 'text'
  const symbol = {
    pdf: <path d="M12 15h9M12 20h15M12 25h11" />,
    text: <path d="M12 15h9M12 20h15M12 25h11" />,
    code: <path d="m15 15-5 5 5 5m10-10 5 5-5 5m-3-11-4 12" />,
    image: <><circle cx="14" cy="16" r="2" fill="white" stroke="none" /><path d="m10 27 7-7 4 4 4-5 6 8z" fill="white" stroke="none" /></>,
    sheet: <path d="M11 14h17v13H11zM11 20h17m-11-6v13" />
  }[type]
  return (
    <span className={`file-mark${small ? ' is-small' : ''}`}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 50" aria-hidden="true">
        <path d="M7 1h18l13 13v31a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" fill={MARK_COLORS[type]} />
        <path d="M25 1v10a3 3 0 0 0 3 3h10" fill="white" fillOpacity=".3" />
        <path d="m25 14 13 8v-8Z" fill="black" fillOpacity=".08" />
        <g stroke="white" strokeOpacity=".9" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none">{symbol}</g>
        <text x="20.5" y="41" textAnchor="middle" fill="white" fontFamily="Inter, system-ui, sans-serif" fontWeight="750" fontSize={ext.length > 3 ? 9 : 11} letterSpacing=".3">{ext}</text>
      </svg>
    </span>
  )
}

function FileCard({ file, remove, fresh }: { file: FileAttachment; remove?: () => void; fresh?: boolean }) {
  const menu = useMenuRequest()
  const open = useApp(state => state.artifact?.kind === 'attachment' && state.artifact.attachment.id === file.id)
  return (
    <div className={`file-attachment${fresh ? ' is-fresh' : ''}`} {...menu.handlers}>
      <button type="button" className={`file-open${open ? ' is-open' : ''}`} aria-label={`Preview ${file.name}`} aria-pressed={open} title={file.name} onClick={() => void openAttachment(file)} draggable
        onDragStart={event => { event.dataTransfer.setData(ATTACHMENT_DRAG_TYPE, JSON.stringify(file)); event.dataTransfer.effectAllowed = 'copy' }}>
        <FileMark file={file} />
        <span className="file-copy"><b>{file.name}</b><small>{fileMeta(file)}</small></span>
      </button>
      <AttachmentMenu attachment={file} onPreview={() => void openAttachment(file)} className="is-file" request={menu.request} />
      {remove && <button type="button" className="image-remove" aria-label={`Remove ${file.name}`} onClick={remove}><X size={12} /></button>}
    </div>
  )
}

/** Images show as thumbnails and files as cards, in one row kept apart from the prompt. */
export function Attachments({ attachments, onRemove, fresh }: { attachments?: Attachment[]; onRemove?: (id: string) => void; fresh?: string | null }) {
  if (!attachments?.length) return null
  return (
    <div className={`image-attachments${onRemove ? ' is-draft' : ''}`}>
      {attachments.map((each, index) => isFileAttachment(each)
        ? <FileCard key={`${each.id}:${index}`} file={each} fresh={each.id === fresh} remove={onRemove ? () => onRemove(each.id) : undefined} />
        : <ImageTile key={`${each.id}:${index}`} image={each} fresh={each.id === fresh} remove={onRemove ? () => onRemove(each.id) : undefined} />)}
    </div>
  )
}
