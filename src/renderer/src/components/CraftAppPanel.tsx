import { useEffect, useRef, useState } from 'react'
import { CraftIcon } from '../craft-icons.tsx'
import { craft, type CraftBounds } from '../craft.ts'
import { clearCraftError, craftStateOf, cwdOf, noteCraftError, peekState, useApp } from '../store.ts'
import { useImagePreviewOpen } from './Attachments.tsx'

// The right side when it shows an installed app: an empty region whose window-relative bounds are
// reported to main, which docks the app's own window exactly over it, as BrowserPanel.tsx does for
// a browser page. Main starts the app on its first show and never closes it; leaving the region
// (the shelf, browser, library or a file shown instead) only hides it.
//
// What is drawn here is seen only while the app's window is not over it: its icon and a spinner
// while it starts, or why it could not.

function boundsOf(element: HTMLElement): CraftBounds {
  const box = element.getBoundingClientRect()
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
}

function message(error: unknown, name: string): string {
  return error instanceof Error ? error.message : `${name} could not be started. Try again, or remove it and install it again from the shelf.`
}

export function CraftAppPanel({ id }: { id: string }) {
  const app = useApp((state) => state.craft.apps.find((entry) => entry.id === id) ?? null)
  const state = useApp((current) => craftStateOf(current, id))
  const covered = useImagePreviewOpen()
  const region = useRef<HTMLDivElement>(null)
  // Bumped by Try again, so the show is asked for afresh.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const element = region.current
    if (!element) return
    const bridge = craft()
    // While a dialog is open over the window the app is hidden, not covered: its window would paint over the dialog.
    if (covered) {
      void bridge.hide()
      return
    }
    let shown = false
    let last = ''
    const report = (): void => {
      const bounds = boundsOf(element)
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      if (key === last || bounds.width === 0 || bounds.height === 0) return
      last = key
      if (!shown) {
        shown = true
        // The chat's folder is the one an app started now may read and write.
        bridge.show(id, bounds, cwdOf(peekState(), 0)).catch((error) => noteCraftError(id, message(error, app?.name ?? 'The app')))
      } else void bridge.setBounds(bounds).catch(() => {})
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    report()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void bridge.hide().catch(() => {})
    }
  }, [id, covered, attempt])

  const name = app?.name ?? id
  const starting = !state.error && (state.run === 'starting' || state.run === 'stopped')
  return (
    <section className="craft-app" aria-label={name} data-app={id} data-run={state.run}>
      <div className="craft-app-region" ref={region} data-testid="craft-app-region">
        <div className="craft-app-placeholder">
          {app && <CraftIcon app={app} size={64} />}
          {state.error ? (
            <>
              <p className="craft-app-error" role="alert">{state.error}</p>
              <button type="button" className="shelf-btn" onClick={() => { clearCraftError(id); setAttempt(attempt + 1) }}>Try again</button>
            </>
          ) : (
            <p className="craft-app-status">
              {starting && <span className="craft-spinner" aria-hidden />}
              {starting ? `Starting ${name}…` : name}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
