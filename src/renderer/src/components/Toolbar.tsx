import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Globe, GripVertical, History as HistoryIcon, LayoutGrid, LibraryBig, SlidersHorizontal, Wrench, type LucideIcon } from 'lucide-react'
import { go } from '../app-map.ts'
import { patchToolbar, resetToolbar, setBrowserOpen, setLibraryOpen, setToolsOpen, sideShown, useApp } from '../store.ts'
import { accessibleName, arrange, labelOf, moveSection, rename, SECTIONS, setKept, type SectionId } from '../toolbar.ts'
import { HistoryMenu } from './History.tsx'

// The strip above the cards, as a Mac unified toolbar: the Sections icon, the drawer of section
// names it slides out to the right, the sections the user keeps in the toolbar for good, and the
// (docs/mockups/titlebar-nav-drawer-mac.html). These are the only buttons
// for the four sections, shown by name alone; only Customize's rows carry an icon. It sits in the
// title strip (TitleStrip.tsx) after the window lights.
//
// The browser's page is a native view that paints over anything drawn across it, so every menu
// and popover here is pulled left until it ends inside the chat card (`useInsideChat`).

const ICONS: Record<SectionId, LucideIcon> = { chats: HistoryIcon, library: LibraryBig, tools: Wrench, browser: Globe }

// Popups are drawn by the toolbar, not inside the drawer, whose clipping would cut them off; `left`
// is where the button that opened one starts, from the toolbar's left edge.
type Popup = { kind: 'menu'; id: SectionId; left: number } | { kind: 'customize'; left: number } | { kind: 'context'; left: number } | null
type Opener = (popup: Popup) => void

/** Where a popup opened from `element` starts, from the toolbar's left edge. */
function leftOf(element: HTMLElement): number {
  const toolbar = element.closest('.toolbar')!.getBoundingClientRect()
  return element.getBoundingClientRect().left - toolbar.left
}

/** Shift a popup left, after it lays out, so its right edge stays inside the chat card. */
function useInsideChat(ref: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    const chat = document.querySelector('.chat')
    if (!element || !chat) return
    const over = element.getBoundingClientRect().right - (chat.getBoundingClientRect().right - 8)
    if (over > 0) element.style.translate = `${-over}px 0`
  }, [ref])
}

function InsideChat({ left, className, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { left: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useInsideChat(ref)
  return <div ref={ref} className={`tb-popup ${className ?? ''}`} style={{ left }} {...rest}>{children}</div>
}

function Section({ id, popup, setPopup, tabbable = true }: { id: SectionId; popup: Popup; setPopup: Opener; tabbable?: boolean }) {
  const toolbar = useApp((state) => state.toolbar)
  const side = useApp(sideShown)
  const label = labelOf(toolbar, id)
  const name = accessibleName(toolbar, id)
  const tabIndex = tabbable ? undefined : -1

  if (SECTIONS[id].kind === 'menu') {
    const open = popup?.kind === 'menu' && popup.id === id
    return (
      <button
        type="button"
        className={`tb-item${open ? ' is-on' : ''}`}
        data-section={id}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabIndex}
        onClick={(event) => setPopup(open ? null : { kind: 'menu', id, left: leftOf(event.currentTarget) })}
      >
        <span>{label}</span>
        <ChevronDown size={12} className="tb-chev" aria-hidden />
      </button>
    )
  }

  const on = side === id
  const toggle = (): void => {
    setPopup(null)
    if (id === 'library') on ? setLibraryOpen(false) : void go('library')
    else if (id === 'tools') on ? setToolsOpen(false) : void go('tools')
    else on ? setBrowserOpen(false) : void go('browser')
  }
  return (
    <button
      type="button"
      className={`tb-item${on ? ' is-on' : ''}`}
      data-section={id}
      aria-label={name}
      aria-pressed={on}
      title={`${on ? 'Hide' : 'Show'} ${label}`}
      tabIndex={tabIndex}
      onClick={toggle}
    >
      <span>{label}</span>
    </button>
  )
}

/** One section's row in Customize: drag handle, rename field, and Keep or Consolidate. */
function CustomizeRow({ id, dragging, setDragging, dropBefore, setDropBefore }: {
  id: SectionId
  dragging: SectionId | null
  setDragging: (id: SectionId | null) => void
  dropBefore: SectionId | 'end' | null
  setDropBefore: (id: SectionId | 'end' | null) => void
}) {
  const toolbar = useApp((state) => state.toolbar)
  const label = labelOf(toolbar, id)
  // The field keeps what is typed, spaces and all; the store keeps the cleaned name.
  const [draft, setDraft] = useState<string | null>(null)
  const kept = toolbar.kept.includes(id)
  const Icon = ICONS[id]
  const real = SECTIONS[id].name
  const at = toolbar.order.indexOf(id)
  const move = (by: number): void => {
    const order = toolbar.order
    const target = at + by
    if (target < 0 || target >= order.length) return
    patchToolbar({ order: moveSection(order, id, by < 0 ? order[target]! : order[target + 1] ?? null) })
  }
  return (
    <div
      className={`tb-row${dragging === id ? ' is-dragging' : ''}${dropBefore === id ? ' is-drop-before' : ''}`}
      data-section={id}
      onDragOver={(event) => {
        if (!dragging) return
        event.preventDefault()
        const box = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > box.top + box.height / 2
        setDropBefore(after ? toolbar.order[at + 1] ?? 'end' : id)
      }}
    >
      <button
        type="button"
        className="tb-handle"
        draggable
        aria-label={`Move ${real}`}
        title="Drag to reorder, or use the arrow keys"
        onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); setDragging(id) }}
        onDragEnd={() => { setDragging(null); setDropBefore(null) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            move(event.key === 'ArrowUp' ? -1 : 1)
          }
        }}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <Icon size={15} className="tb-row-icon" aria-hidden />
      <input
        className="tb-name"
        value={draft ?? label}
        maxLength={24}
        spellCheck={false}
        aria-label={`Name for ${real}`}
        onChange={(event) => {
          setDraft(event.target.value)
          patchToolbar({ names: rename(toolbar, id, event.target.value) })
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
      {label !== real && <span className="tb-was">was {real}</span>}
      <span className="tb-choice" role="radiogroup" aria-label={`Where ${real} goes`}>
        <button type="button" role="radio" aria-checked={kept} className={kept ? 'is-on' : ''} onClick={() => patchToolbar({ kept: setKept(toolbar, id, true) })}>Keep</button>
        <button type="button" role="radio" aria-checked={!kept} className={kept ? '' : 'is-on'} onClick={() => patchToolbar({ kept: setKept(toolbar, id, false) })}>Consolidate</button>
      </span>
    </div>
  )
}

function Customize({ left, close }: { left: number; close: () => void }) {
  const order = useApp((state) => state.toolbar.order)
  const [dragging, setDragging] = useState<SectionId | null>(null)
  const [dropBefore, setDropBefore] = useState<SectionId | 'end' | null>(null)
  return (
    <InsideChat left={left} className="tb-customize" role="dialog" aria-label="Customize sections">
      <div className="tb-customize-head">
        <strong>Customize Sections</strong>
        <span>Rename, drag to reorder, and choose what stays in the toolbar.</span>
      </div>
      <div
        className={`tb-rows${dropBefore === 'end' ? ' is-drop-end' : ''}`}
        onDrop={(event) => {
          event.preventDefault()
          if (dragging && dropBefore) patchToolbar({ order: moveSection(order, dragging, dropBefore === 'end' ? null : dropBefore) })
          setDragging(null)
          setDropBefore(null)
        }}
      >
        {order.map((id) => <CustomizeRow key={id} id={id} dragging={dragging} setDragging={setDragging} dropBefore={dropBefore} setDropBefore={setDropBefore} />)}
      </div>
      <div className="tb-customize-foot">
        <button type="button" className="tb-link" onClick={resetToolbar}>Restore Defaults</button>
        <button type="button" className="tb-done" onClick={close}>Done</button>
      </div>
    </InsideChat>
  )
}

/** Right-click on the Sections icon: keep any section in one click, or open Customize. */
function ContextMenu({ left, setPopup }: { left: number; setPopup: Opener }) {
  const toolbar = useApp((state) => state.toolbar)
  return (
    <InsideChat left={left} className="tb-context" role="menu" aria-label="Sections">
      {toolbar.order.map((id) => {
        const kept = toolbar.kept.includes(id)
        return (
          <button key={id} type="button" role="menuitemcheckbox" aria-checked={kept} onClick={() => { patchToolbar({ kept: setKept(toolbar, id, !kept) }); setPopup(null) }}>
            <span className="tb-check">{kept && <Check size={12} aria-hidden />}</span>
            Keep {labelOf(toolbar, id)} in Toolbar
          </button>
        )
      })}
      <hr />
      <button type="button" role="menuitem" onClick={() => setPopup({ kind: 'customize', left })}>
        <span className="tb-check" />
        Customize Sections…
      </button>
    </InsideChat>
  )
}

export function Toolbar() {
  const toolbar = useApp((state) => state.toolbar)
  const [popup, setPopup] = useState<Popup>(null)
  const root = useRef<HTMLDivElement>(null)
  const drawer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const { kept, drawer: tucked } = arrange(toolbar)
  const open = toolbar.open

  // The drawer's width follows its contents, so it slides to the right size and back to nothing.
  // Measuring forces a layout, so it runs only when what is in the drawer changes.
  useLayoutEffect(() => {
    if (drawer.current && inner.current) drawer.current.style.width = open ? `${inner.current.scrollWidth}px` : '0px'
  }, [open, toolbar])

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      if (popup && !root.current?.contains(event.target as Node)) setPopup(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (popup) {
        event.stopPropagation()
        setPopup(null)
      } else if (open && root.current?.contains(document.activeElement)) {
        patchToolbar({ open: false })
      }
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [popup, open])

  const close = (): void => setPopup(null)
  return (
    <div className="toolbar" ref={root}>
      <div className={`tb-glass tb-dock${open ? ' is-open' : ''}`}>
          <button
            type="button"
            className="tb-toggle"
            aria-label="Sections"
            title={`${open ? 'Hide' : 'Show'} sections`}
            aria-expanded={open}
            onClick={() => { setPopup(null); patchToolbar({ open: !open }) }}
            onContextMenu={(event) => { event.preventDefault(); setPopup({ kind: 'context', left: leftOf(event.currentTarget) }) }}
          >
            <LayoutGrid size={16} aria-hidden />
          </button>
          <div className="tb-drawer" ref={drawer} inert={!open} aria-hidden={!open}>
            <div className="tb-drawer-inner" ref={inner}>
              {tucked.map((id, index) => (
                <div key={id} className="tb-slide" style={{ transitionDelay: open ? `${index * 30}ms` : '0ms' }}>
                  <Section id={id} popup={popup} setPopup={setPopup} tabbable={open} />
                </div>
              ))}
              {tucked.length > 0 && <span className="tb-sep tb-slide" aria-hidden />}
              <button
                type="button"
                className={`tb-item tb-customize-button tb-slide${popup?.kind === 'customize' ? ' is-on' : ''}`}
                aria-label="Customize sections…"
                title="Customize Sections…"
                aria-haspopup="dialog"
                aria-expanded={popup?.kind === 'customize'}
                onClick={(event) => setPopup(popup?.kind === 'customize' ? null : { kind: 'customize', left: leftOf(event.currentTarget.closest('.tb-dock') as HTMLElement) })}
              >
                <SlidersHorizontal size={14} aria-hidden />
              </button>
            </div>
          </div>
      </div>
      {kept.length > 0 && (
        <div className="tb-glass tb-kept">
          {kept.map((id) => <Section key={id} id={id} popup={popup} setPopup={setPopup} />)}
        </div>
      )}
      {popup?.kind === 'menu' && (
        <InsideChat key={popup.id} left={popup.left}>
          <HistoryMenu onPick={close} />
        </InsideChat>
      )}
      {popup?.kind === 'customize' && <Customize left={popup.left} close={close} />}
      {popup?.kind === 'context' && <ContextMenu left={popup.left} setPopup={setPopup} />}
    </div>
  )
}
