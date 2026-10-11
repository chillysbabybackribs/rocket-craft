import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Globe, Plus, Volume2, VolumeX, X } from 'lucide-react'
import type { BrowserTab } from '../../../shared/types.ts'

// The browser's tab strip, after Chromium's: tabs share the width and shrink as they multiply,
// the selected one is joined to the toolbar beneath it, pinned tabs are icons at the front, and
// a tab can be dragged along the strip to a new place.

const send = window.rocket.browser.send

type Press = { id: string; startX: number; from: number; first: number; last: number; width: number }
type Drag = { id: string; from: number; to: number; dx: number; width: number }

function reorder(tabs: BrowserTab[], from: number, to: number): BrowserTab[] {
  const next = [...tabs]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

export function BrowserTabs({ tabs: current, activeId }: { tabs: BrowserTab[]; activeId: string | null }) {
  const press = useRef<Press | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The order after a drop, shown until main confirms it, so the tabs never jump back.
  const [dropped, setDropped] = useState<BrowserTab[] | null>(null)
  useEffect(() => setDropped(null), [current])
  const tabs = dropped ?? current

  const down = (event: PointerEvent<HTMLDivElement>, tab: BrowserTab, index: number): void => {
    if (event.button !== 0) return
    if (tab.id !== activeId) send({ type: 'activateTab', id: tab.id })
    // A tab moves only among its own kind: pinned tabs stay in front of the others.
    const pinned = tabs.filter((entry) => entry.pinned).length
    press.current = {
      id: tab.id,
      startX: event.clientX,
      from: index,
      first: tab.pinned ? 0 : pinned,
      last: tab.pinned ? pinned - 1 : tabs.length - 1,
      width: event.currentTarget.getBoundingClientRect().width
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const held = press.current
    if (!held) return
    const pulled = event.clientX - held.startX
    if (!drag && Math.abs(pulled) < 5) return
    const dx = Math.min(Math.max(pulled, (held.first - held.from) * held.width), (held.last - held.from) * held.width)
    setDrag({ id: held.id, from: held.from, to: held.from + Math.round(dx / held.width), dx, width: held.width })
  }

  const up = (): void => {
    press.current = null
    if (drag && drag.to !== drag.from) {
      setDropped(reorder(tabs, drag.from, drag.to))
      send({ type: 'moveTab', id: drag.id, index: drag.to })
    }
    setDrag(null)
  }

  /** While one tab is dragged, the tabs it passes step aside by one place. */
  const shift = (index: number): CSSProperties | undefined => {
    if (!drag) return undefined
    if (index === drag.from) return { transform: `translateX(${drag.dx}px)`, transition: 'none', zIndex: 2 }
    if (index > drag.from && index <= drag.to) return { transform: `translateX(${-drag.width}px)` }
    if (index < drag.from && index >= drag.to) return { transform: `translateX(${drag.width}px)` }
    return undefined
  }

  return (
    <div className={`btabs${drag ? ' is-dragging' : ''}`}>
      <div
        className="btabs-list"
        role="tablist"
        aria-label="Browser tabs"
        style={{ '--tabs': tabs.filter((tab) => !tab.pinned).length, '--pinned': tabs.filter((tab) => tab.pinned).length } as CSSProperties}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`btab${active ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}${tab.agent ? ' is-agent' : ''}`}
              title={tab.agent ? `${tab.title} (opened by the agent)` : tab.title}
              style={shift(index)}
              onPointerDown={(event) => down(event, tab, index)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onMouseDown={(event) => {
                // Middle click closes the tab rather than starting a scroll or a paste.
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => {
                if (event.button === 1) send({ type: 'closeTab', id: tab.id })
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                send({ type: 'tabMenu', id: tab.id })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') send({ type: 'activateTab', id: tab.id })
              }}
            >
              <span className="btab-sep" />
              <span className="btab-icon">
                {tab.loading
                  ? <span className="btab-spinner" aria-label="Loading" />
                  : tab.favicon
                    ? <img src={tab.favicon} alt="" draggable={false} />
                    : <Globe size={14} />}
              </span>
              {!tab.pinned && <span className="btab-title">{tab.title}</span>}
              {!tab.pinned && (tab.audible || tab.muted) && (
                <button
                  type="button"
                  className="btab-audio"
                  aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => send({ type: 'muteTab', id: tab.id, muted: !tab.muted })}
                >
                  {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
              )}
              {!tab.pinned && (
                <button
                  type="button"
                  className="btab-close"
                  aria-label={`Close tab: ${tab.title}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => send({ type: 'closeTab', id: tab.id })}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button type="button" className="btab-new" title="New tab" aria-label="New tab" onClick={() => send({ type: 'newTab' })}>
        <Plus size={15} />
      </button>
    </div>
  )
}
