import { useRef } from 'react'
import { setSideWidth, useApp } from '../store.ts'

const SIDE_MIN = 320
const CHAT_MIN = 300

/**
 * A chat with something beside it, split like an artifact: the conversation on the left, `side`
 * on the right, with a divider to drag. The plan drawer lives here, in the leader's column and in
 * an expanded worker. The side's width is the dragged one only as far as the container leaves the
 * conversation its share (styles.css `.pane-split.is-split`), so a narrow column never clips it.
 */
export function Split({ side, children }: { side: React.ReactNode; children: React.ReactNode }) {
  const width = useApp((state) => state.sideWidth)
  const split = useRef<HTMLDivElement>(null)

  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-dragging')
    let last = width
    const move = (moved: PointerEvent): void => {
      const box = split.current!.getBoundingClientRect()
      last = Math.round(Math.max(SIDE_MIN, Math.min(box.width - CHAT_MIN, box.right - moved.clientX)))
      setSideWidth(last, false)
    }
    const up = (): void => {
      handle.classList.remove('is-dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      setSideWidth(last, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  return (
    <div ref={split} className={`pane-split${side ? ' is-split' : ''}`} style={{ '--side-width': `${width}px` } as React.CSSProperties}>
      <div className="split-chat">{children}</div>
      {side && (
        <>
          <div className="side-divider" role="separator" aria-orientation="vertical" aria-label="Resize the side pane" onPointerDown={drag} />
          {side}
        </>
      )}
    </div>
  )
}
