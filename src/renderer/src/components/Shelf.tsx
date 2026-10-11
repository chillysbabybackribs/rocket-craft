import { useEffect, useRef, useState } from 'react'
import { go } from '../app-map.ts'
import { CraftIcon } from '../craft-icons.tsx'
import { isRunning, shelfOrder, sizeText, type CraftAppInfo } from '../craft.ts'
import { craftStateOf, installApp, isInstalled, removeApp, useApp } from '../store.ts'

// The shelf (docs/mockups/craft-shelf.html): every Craft app as a card in one grid, creative apps
// first, centred in the right side. It is what the right side shows on first run, when nothing is
// installed, and what the dock's + Add opens. Installing and removing are the user's alone: these
// buttons call the store directly and the app map has no action for either, so a model can only
// suggest one.
//
// The card's ⋯ menu opens upward inside the card. The shelf is only shown when no app is docked,
// so no native window is over it, and opening upward keeps it clear of the dock below.

function MoreMenu({ app, onRemove }: { app: CraftAppInfo; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (event: PointerEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="shelf-more-box" ref={box}>
      <button
        ref={trigger}
        type="button"
        className={`shelf-more${open ? ' is-open' : ''}`}
        aria-label={`More for ${app.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
      </button>
      {open && (
        <div className="shelf-menu" role="menu" aria-label={`${app.name} actions`}>
          {app.installedVersion && <div className="shelf-menu-note">Version {app.installedVersion}</div>}
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setOpen(false); onRemove() }}>Remove</button>
        </div>
      )}
    </div>
  )
}

function ShelfCard({ app }: { app: CraftAppInfo }) {
  const state = useApp((current) => craftStateOf(current, app.id))
  // Removing a running app ends it, so that one asks first; the question is the card's own moment.
  const [confirming, setConfirming] = useState(false)
  const percent = Math.round((state.progress ?? 0) * 100)
  const installed = state.installState === 'installed'
  const remove = (): void => {
    if (isRunning(state) && !confirming) return setConfirming(true)
    setConfirming(false)
    void removeApp(app.id)
  }

  let body: React.ReactNode = <div className="shelf-desc">{app.description}</div>
  let foot: React.ReactNode
  if (state.installState === 'installing') {
    foot = (
      <div className="shelf-progress">
        <span className="shelf-bar" role="progressbar" aria-label={`Installing ${app.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ width: `${percent}%` }} />
        </span>
        <small><span>Installing…</span><span>{percent}%</span></small>
      </div>
    )
  } else if (installed && confirming) {
    body = <div className="shelf-desc shelf-ask">{app.name} is open; unsaved work in it is lost.</div>
    foot = (
      <>
        <button type="button" className="shelf-btn is-danger" aria-label={`Remove ${app.name} now`} onClick={remove}>Remove</button>
        <button type="button" className="shelf-btn is-quiet" onClick={() => setConfirming(false)}>Keep</button>
      </>
    )
  } else if (installed) {
    foot = (
      <>
        <button type="button" className="shelf-btn is-open" data-nav="app" aria-label={`Open ${app.name}`} onClick={() => void go('app', { id: app.id })}>Open</button>
        <MoreMenu app={app} onRemove={remove} />
      </>
    )
  } else if (state.installState === 'failed') {
    body = <p className="shelf-desc shelf-error" role="alert">{state.error ?? `${app.name} could not be installed. Check your connection and press Retry.`}</p>
    foot = <button type="button" className="shelf-btn is-primary" aria-label={`Retry installing ${app.name}`} onClick={() => void installApp(app.id)}>Retry</button>
  } else {
    foot = <button type="button" className="shelf-btn is-install" aria-label={`Install ${app.name}`} onClick={() => void installApp(app.id)}>Install</button>
  }

  return (
    <article className={`shelf-card is-${state.installState}`} data-app={app.id} aria-label={app.name} style={{ '--a': app.accent } as React.CSSProperties}>
      <div className="shelf-top">
        <CraftIcon app={app} size={56} />
        {!installed && <span className="shelf-chip">{sizeText(app.sizeBytes)}</span>}
      </div>
      <div className="shelf-name">{app.name}</div>
      <div className="shelf-like">Like {app.likeName}</div>
      {body}
      <div className="shelf-foot">{foot}</div>
    </article>
  )
}

type Filter = 'all' | 'installed'

export function Shelf() {
  const craft = useApp((state) => state.craft)
  // Which apps the grid shows is the user's view only; a model has no use for it, so it stays here.
  const [filter, setFilter] = useState<Filter>('all')
  // The block is centred for the full grid; a shorter filtered grid keeps its header where it was
  // rather than jumping to a new centre. A window resize lets it centre again.
  const inner = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  useEffect(() => {
    if (pinned === null) return
    const release = (): void => setPinned(null)
    window.addEventListener('resize', release)
    return () => window.removeEventListener('resize', release)
  }, [pinned])
  const choose = (value: Filter): void => {
    if (value === filter) return
    const block = inner.current
    setPinned(value === 'installed' && block ? block.offsetTop : null)
    setFilter(value)
  }
  const apps = shelfOrder(craft.apps)
  const installed = apps.filter((app) => isInstalled({ craft }, app.id))
  const bytes = installed.reduce((sum, app) => sum + app.sizeBytes, 0)
  const shown = filter === 'installed' ? installed : apps
  const segment = (value: Filter, label: string, count: number): React.ReactNode => (
    <button type="button" className={filter === value ? 'is-on' : ''} aria-label={`${label} ${count}`} aria-pressed={filter === value} onClick={() => choose(value)}>
      {label}<em>{count}</em>
    </button>
  )
  return (
    <section className="shelf" aria-label="Apps shelf">
      <div className="shelf-inner" ref={inner} style={pinned === null ? undefined : { marginTop: pinned, marginBottom: 'auto' }}>
        <header className="shelf-head">
          <div className="shelf-title">
            <h2>Apps</h2>
            <p>Install only what you use. Each opens beside the chat, and models can work in it with you.</p>
          </div>
          <div className="shelf-meta">
            <div className="shelf-seg" role="group" aria-label="Show apps">
              {segment('all', 'All', apps.length)}
              {segment('installed', 'Installed', installed.length)}
            </div>
            <span className="shelf-disk">{installed.length ? `${sizeText(bytes)} on disk` : 'Nothing installed yet'}</span>
          </div>
        </header>
        {craft.error && <p className="shelf-error">{craft.error}</p>}
        {!craft.loaded && <p className="shelf-empty">Reading the app catalog…</p>}
        {craft.loaded && filter === 'installed' && !installed.length && (
          <div className="shelf-empty">
            <p>Nothing is installed yet. Install an app from All and it will be listed here and in the dock.</p>
            <button type="button" className="shelf-btn" onClick={() => choose('all')}>Show all apps</button>
          </div>
        )}
        <div className="shelf-grid">
          {shown.map((app) => <ShelfCard key={app.id} app={app} />)}
        </div>
      </div>
    </section>
  )
}
