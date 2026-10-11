import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, Camera, Eraser, Globe, Monitor, Paintbrush, SquareDashed, Trash2, X } from 'lucide-react'
import { MAX_IMAGE_BYTES, type CaptureRequest, type CaptureResult, type CaptureSource } from '../../../shared/types.ts'
import { addDraftFiles, draftOf, updateDraft } from '../drafts.ts'
import { setPreviewOpen } from './Attachments.tsx'
import { showNotice } from './AttachmentMenu.tsx'

// The composer's camera (docs/mockups/screen-capture.html): capture the browser page, Craft Studio, any
// other window, the screen, or a region, review it, draw on it, and add it to the draft the camera
// belongs to. Main does the capturing (src/main/capture.ts); nothing here talks to a provider, and
// nothing is sent. The destination is fixed when the menu opens, so clicking another pane while a
// capture is under way cannot redirect it.

const COLORS = [['Red', '#ff3b30'], ['Yellow', '#ffd60a'], ['Blue', '#0a84ff'], ['White', '#ffffff']] as const
const PEN = 4
const ERASER = 18
const MAX_SIDE = 8000
const MAX_PIXELS = 32_000_000

type Target = { key: string; title: string }
type Shot = { result: CaptureResult; request: CaptureRequest }

/** Two frames, so a menu or dialog that was just closed is gone from the screen before a capture. */
const settle = (extra = 0): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, extra))))
const messageOf = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The capture failed. Try again.')

export function CaptureButton({ draftKey, title, disabled }: { draftKey: string; title: string; disabled: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  const target = useRef<Target>({ key: draftKey, title })
  const [menu, setMenu] = useState(false)
  const [picker, setPicker] = useState<CaptureSource[] | 'loading' | null>(null)
  const [shot, setShot] = useState<Shot | null>(null)
  const [busy, setBusy] = useState(false)

  const take = async (request: CaptureRequest): Promise<void> => {
    setMenu(false)
    setBusy(true)
    try {
      await settle(request.kind === 'source' ? 120 : 0)
      const result = await window.rocket.capture.take(request)
      if (result) setShot({ result, request })
    } catch (error) {
      showNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const openPicker = async (): Promise<void> => {
    setMenu(false)
    setPicker('loading')
    try { setPicker(await window.rocket.capture.sources()) } catch (error) { setPicker(null); showNotice(messageOf(error)) }
  }
  const add = async (file: File): Promise<void> => {
    const { key, title: to } = target.current
    setShot(null)
    const added = await addDraftFiles(key, [file])
    if (!added.length) return
    const ids = new Set(added.map((each) => each.id))
    updateDraft(key, { fresh: added[0]!.id })
    setTimeout(() => { if (draftOf(key).fresh === added[0]!.id) updateDraft(key, { fresh: null }) }, 1600)
    showNotice(`Added ${file.name} to ${to}${to.endsWith('…') ? '' : '.'} Nothing was sent.`, () => updateDraft(key, { attachments: draftOf(key).attachments.filter((each) => !ids.has(each.id)) }))
  }

  return (
    <>
      <button ref={button} type="button" className="composer-attach composer-capture" aria-label="Capture" title="Capture the screen into this draft" aria-haspopup="menu" aria-expanded={menu}
        disabled={disabled || busy} onClick={() => { target.current = { key: draftKey, title }; setMenu(!menu) }}>
        <Camera size={16} />
      </button>
      {menu && <CaptureMenu anchor={button.current} onClose={() => setMenu(false)} onPick={(kind) => {
        if (kind === 'apps') void openPicker()
        else void take({ kind } as CaptureRequest)
      }} />}
      {picker && <SourcePicker sources={picker} onCancel={() => setPicker(null)} onPick={(id) => { setPicker(null); void take({ kind: 'source', id }) }} />}
      {shot && <Review shot={shot.result} to={target.current.title} onCancel={() => setShot(null)} onAdd={(file) => void add(file)}
        onRetake={() => { const request = shot.request; setShot(null); if (request.kind === 'source') void openPicker(); else void take(request) }} />}
    </>
  )
}

type MenuKind = 'page' | 'rocket' | 'apps' | 'screen' | 'region'

function CaptureMenu({ anchor, onClose, onPick }: { anchor: HTMLElement | null; onClose: () => void; onPick: (kind: MenuKind) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element || !anchor) return
    const from = anchor.getBoundingClientRect()
    const bounds = anchor.closest('.chat')?.getBoundingClientRect() ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    const size = element.getBoundingClientRect()
    const left = Math.max(bounds.left + 8, Math.min(from.left, bounds.right - size.width - 8))
    const top = from.top - size.height - 8 >= bounds.top + 8 ? from.top - size.height - 8 : from.bottom + 8
    setPlace({ left, top })
    element.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [anchor])
  useEffect(() => {
    const outside = (event: MouseEvent): void => { if (!box.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose() }
    document.addEventListener('mousedown', outside, true)
    return () => document.removeEventListener('mousedown', outside, true)
  }, [anchor, onClose])
  const items: Array<[MenuKind, typeof Globe, string, string]> = [
    ['page', Globe, 'Browser page', 'What is visible in the current tab'],
    ['rocket', AppWindow, 'Craft Studio window', 'Chats, browser and panels as they are'],
    ['apps', AppWindow, 'Another app\'s window…', 'Terminal, Firefox, Files or anything open'],
    ['screen', Monitor, 'Entire screen', 'The screen the pointer is on'],
    ['region', SquareDashed, 'Select a region…', 'Drag over anything on screen']
  ]
  return createPortal(
    <div ref={box} className="attachment-menu capture-menu" role="menu" aria-label="Capture" style={place ?? { visibility: 'hidden' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); anchor?.focus(); return }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const all = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]')]
        const index = all.indexOf(document.activeElement as HTMLElement)
        all.at(event.key === 'ArrowDown' ? (index + 1) % all.length : index - 1)?.focus()
      }}>
      {items.map(([kind, Icon, label, detail]) => (
        <button key={kind} type="button" role="menuitem" className="attachment-menu-item capture-item" onClick={() => onPick(kind)}>
          <Icon size={15} /><span><span>{label}</span><small>{detail}</small></span>
        </button>
      ))}
      <div className="attachment-picker-foot">Adds to this chat's draft. You review it first; nothing is sent.</div>
    </div>,
    document.body
  )
}

/** A modal dialog that also hides the native browser view, which would otherwise draw over it. */
function useModal(onCancel: () => void) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    setPreviewOpen(true)
    dialog.current?.showModal()
    return () => setPreviewOpen(false)
  }, [])
  return { ref: dialog, onCancel: (event: Event | React.SyntheticEvent) => { event.preventDefault(); onCancel() } }
}

function SourcePicker({ sources, onPick, onCancel }: { sources: CaptureSource[] | 'loading'; onPick: (id: string) => void; onCancel: () => void }) {
  const modal = useModal(onCancel)
  return (
    <dialog ref={modal.ref} className="capture-dialog capture-picker" aria-label="Capture a window or screen" onCancel={modal.onCancel}>
      <div className="capture-head"><b>Capture a window or screen</b><button type="button" className="icon-button" aria-label="Cancel" onClick={onCancel}><X size={16} /></button></div>
      {sources === 'loading' ? <p className="capture-empty">Looking for windows…</p>
        : !sources.length ? <p className="capture-empty">No windows could be found to capture. Use Select a region instead.</p>
        : <div className="capture-grid">
            {sources.map((source) => (
              <button key={source.id} type="button" className="capture-source" aria-label={`Capture ${source.name}`} onClick={() => onPick(source.id)}>
                <span className="capture-thumb"><img src={source.thumbnail} alt="" /></span>
                <span className="capture-label">
                  {source.icon ? <img src={source.icon} alt="" /> : source.kind === 'screen' ? <Monitor size={14} /> : <AppWindow size={14} />}
                  <span>{source.own ? 'Craft Studio' : source.name}</span>
                </span>
              </button>
            ))}
          </div>}
      <div className="capture-foot"><span>Pick one to capture it as it is now.</span><button type="button" className="gp-button" onClick={onCancel}>Cancel</button></div>
    </dialog>
  )
}

/**
 * The capture at its own resolution with a paint layer the same size on top. Strokes are drawn in
 * image pixels, so the drawing is as sharp as the capture; the eraser removes paint only.
 */
function Review({ shot, to, onRetake, onCancel, onAdd }: { shot: CaptureResult; to: string; onRetake: () => void; onCancel: () => void; onAdd: (file: File) => void }) {
  const modal = useModal(onCancel)
  // The window's CSP allows data: images, not blob: ones.
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = () => setSrc(String(reader.result))
    reader.readAsDataURL(new Blob([shot.png as BlobPart], { type: 'image/png' }))
    return () => reader.abort()
  }, [shot])
  const image = useRef<HTMLImageElement>(null)
  const paint = useRef<HTMLCanvasElement>(null)
  const last = useRef<[number, number] | null>(null)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [color, setColor] = useState<string>(COLORS[0][1])
  const [name, setName] = useState(shot.name)
  const [saving, setSaving] = useState(false)

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [(event.clientX - rect.left) * (shot.width / rect.width), (event.clientY - rect.top) * (shot.height / rect.height)]
  }
  const stroke = (from: [number, number], to: [number, number], canvas: HTMLCanvasElement): void => {
    const context = canvas.getContext('2d')!
    const scale = shot.width / canvas.getBoundingClientRect().width
    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    context.strokeStyle = color
    context.lineWidth = (tool === 'eraser' ? ERASER : PEN) * scale
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(...from)
    context.lineTo(...to)
    context.stroke()
  }

  const save = async (): Promise<void> => {
    if (!image.current || !paint.current) return
    setSaving(true)
    try {
      let { width, height } = shot
      const shrink = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
      width = Math.round(width * shrink)
      height = Math.round(height * shrink)
      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const context = out.getContext('2d')!
      context.drawImage(image.current, 0, 0, width, height)
      context.drawImage(paint.current, 0, 0, width, height)
      const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The capture could not be saved. Try again.'))), type, quality))
      // PNG keeps screenshot text crisp; a busy full screen over the image limit is sent as JPEG instead.
      let blob = await encode('image/png')
      if (blob.size > MAX_IMAGE_BYTES) blob = await encode('image/jpeg', 0.92)
      if (blob.size > MAX_IMAGE_BYTES) blob = await encode('image/jpeg', 0.8)
      const base = (name.trim() || shot.name).replace(/\.(png|jpe?g)$/i, '')
      onAdd(new File([blob], `${base}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type }))
    } catch (error) {
      showNotice(messageOf(error))
      setSaving(false)
    }
  }

  return (
    <dialog ref={modal.ref} className="capture-dialog capture-review" aria-label="Review capture" onCancel={modal.onCancel}>
      <div className="capture-head"><b>Review capture</b><button type="button" className="icon-button" aria-label="Cancel" onClick={onCancel}><X size={16} /></button></div>
      <div className="capture-paint" role="toolbar" aria-label="Draw on the capture">
        <button type="button" className="capture-tool" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}><Paintbrush size={14} />Pen</button>
        {COLORS.map(([label, value]) => (
          <button key={value} type="button" className="capture-swatch" style={{ background: value }} aria-label={label} aria-pressed={tool === 'pen' && color === value}
            onClick={() => { setColor(value); setTool('pen') }} />
        ))}
        <span className="capture-sep" />
        <button type="button" className="capture-tool" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}><Eraser size={14} />Eraser</button>
        <button type="button" className="capture-tool" onClick={() => paint.current?.getContext('2d')!.clearRect(0, 0, shot.width, shot.height)}><Trash2 size={14} />Clear</button>
        <span className="capture-grow" /><span className="capture-hint">Draw over what matters</span>
      </div>
      <div className="capture-frame">
        <div className="capture-canvas">
          {src ? <img ref={image} src={src} alt={`Capture: ${shot.from}`} draggable={false} /> : <span className="capture-empty">Loading the capture…</span>}
          {src && <canvas ref={paint} width={shot.width} height={shot.height} className={tool === 'eraser' ? 'is-erasing' : ''} aria-label="Drawing layer"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); last.current = point(event); stroke(last.current, last.current, event.currentTarget) }}
            onPointerMove={(event) => { if (!last.current) return; const next = point(event); stroke(last.current, next, event.currentTarget); last.current = next }}
            onPointerUp={() => { last.current = null }} onPointerCancel={() => { last.current = null }} />}
        </div>
      </div>
      <div className="capture-fields">
        <label htmlFor="capture-name">Name</label><input id="capture-name" value={name} onChange={(event) => setName(event.target.value)} />
        <span>Size</span><span className="capture-value">{shot.width} × {shot.height} px · source pixels</span>
        <span>From</span><span className="capture-value" title={shot.from}>{shot.from}</span>
      </div>
      <div className="capture-actions">
        <span className="capture-to">Adds to: {to} (this chat's draft)</span>
        <span className="capture-buttons">
          <button type="button" className="gp-button" onClick={onRetake}>Retake</button>
          <button type="button" className="gp-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="gp-button is-primary" disabled={saving || !src} onClick={() => void save()} autoFocus>Add to draft</button>
        </span>
      </div>
    </dialog>
  )
}
