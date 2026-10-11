import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { HistoryMenu } from './History.tsx'

// Chats opens the list of every chat from an icon just above the composer's top-right corner
// (docs/mockups/craft-studio.html). Browser and Library are toggles in the right side's header (SideNav.tsx).
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

export function ChatsMenu() {
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
    const anchor = root.current?.getBoundingClientRect()
    const box = button.current?.getBoundingClientRect()
    return anchor && box ? box.left - anchor.left : 0
  }
  return (
    <div className="composer-chats" ref={root}>
      <button
        ref={button}
        type="button"
        className={`composer-attach composer-chats-btn${open ? ' is-on' : ''}`}
        data-section="chats"
        aria-label="Chats"
        title="Chats"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MessagesSquare size={16} aria-hidden />
      </button>
      {open && (
        <InsideChat left={left()}>
          <HistoryMenu onPick={() => setOpen(false)} />
        </InsideChat>
      )}
    </div>
  )
}
