import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { HistoryMenu } from './History.tsx'

// The strip's one button, Chats, which opens the list of every chat (docs/mockups/craft-studio.html).
// Rocket's other sections moved: the browser and the library are toggles at the dock's right end
// (Dock.tsx), and the tool ledger's panel was dropped. It sits in the title strip (TitleStrip.tsx)
// after the window lights.
//
// A docked app window and the browser's page are native views that paint over anything drawn
// across the right side, so the menu is pulled left until it ends inside the chat card.

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

function InsideChat({ left, children }: { left: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useInsideChat(ref)
  return <div ref={ref} className="tb-popup" style={{ left }}>{children}</div>
}

export function Toolbar() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const left = (): number => {
    const toolbar = root.current?.getBoundingClientRect()
    const box = button.current?.getBoundingClientRect()
    return toolbar && box ? box.left - toolbar.left : 0
  }
  return (
    <div className="toolbar" ref={root}>
      <div className="tb-glass tb-kept">
        <button
          ref={button}
          type="button"
          className={`tb-item${open ? ' is-on' : ''}`}
          data-section="chats"
          aria-label="Chats"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span>Chats</span>
          <ChevronDown size={12} className="tb-chev" aria-hidden />
        </button>
      </div>
      {open && (
        <InsideChat left={left()}>
          <HistoryMenu onPick={() => setOpen(false)} />
        </InsideChat>
      )}
    </div>
  )
}
