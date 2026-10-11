import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { BrowserReading } from '../../../shared/types.ts'
import { nudgeSpeed } from '../../../shared/reading.ts'
import { setReadingSpeed, useApp } from '../store.ts'
import { PanelReading } from '../panel-reader.ts'
import { ReadingControl, type ReadingActions } from './ReadingControl.tsx'

// Hands-free reading in the file panel's header. Its state is its own, not the panel's, so the
// ring moving a few times a second re-renders this control and not the document under it.
// A new file starts at rest. The keys are the browser's, taken while focus is in the panel:
// Alt+S starts or stops, Space pauses and carries on, Esc stops, Alt+↑/↓ is slower or faster.

const editable = (target: EventTarget | null): boolean => target instanceof HTMLElement
  && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))

export function PanelReader({ panel, file }: { panel: RefObject<HTMLElement | null>; file: string }) {
  const speed = useApp((state) => state.readingSpeed)
  const [reading, setReading] = useState<BrowserReading | null>(null)
  const engine = useRef<PanelReading | null>(null)
  const speedNow = useRef(speed)
  speedNow.current = speed

  useEffect(() => {
    const element = panel.current
    if (!element) return
    const reader = new PanelReading(element, setReading)
    reader.setSpeed(speedNow.current)
    engine.current = reader
    setReading(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        reader.flip()
        return
      }
      if (!reader.on || event.ctrlKey || event.metaKey) return
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        setReadingSpeed(nudgeSpeed(speedNow.current, event.key === 'ArrowUp' ? -1 : 1))
      } else if (event.key === 'Escape') reader.stop()
      else if (event.key === ' ' && !event.altKey && !editable(event.target)) {
        event.preventDefault()
        reader.toggle()
      } else if (!event.altKey) reader.scrollKey(event.key)
    }
    element.addEventListener('keydown', onKey)
    return () => {
      element.removeEventListener('keydown', onKey)
      reader.dispose()
      engine.current = null
    }
  }, [panel, file])

  useEffect(() => { engine.current?.setSpeed(speed) }, [speed])

  const actions = useMemo<ReadingActions>(() => ({
    flip: () => engine.current?.flip(),
    toggle: () => engine.current?.toggle(),
    stop: () => engine.current?.stop(),
    setSpeed: (next) => setReadingSpeed(next)
  }), [])
  return <ReadingControl reading={reading} speed={speed} actions={actions} />
}
