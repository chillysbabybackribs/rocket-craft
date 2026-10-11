import { useState } from 'react'
import { go } from '../app-map.ts'
import { isRunning, sizeText, type CraftAppInfo } from '../craft.ts'
import { craftStateOf, installApp, isInstalled, removeApp, useApp } from '../store.ts'
import { AppIcon } from './Dock.tsx'

// The shelf (docs/mockups/craft-studio.html, second screen): every Craft app as a card, to install,
// open or remove. It is what the right side shows on first run, when nothing is installed, and
// what the dock's + Add opens. Installing and removing are the user's alone: these buttons call
// the store directly and the app map has no action for either, so a model can only suggest one.

function ShelfCard({ app }: { app: CraftAppInfo }) {
  const state = useApp((current) => craftStateOf(current, app.id))
  // Removing a running app ends it, so that one asks first; the question is the card's own moment.
  const [confirming, setConfirming] = useState(false)
  const percent = Math.round((state.progress ?? 0) * 100)
  const remove = (): void => {
    if (isRunning(state) && !confirming) return setConfirming(true)
    setConfirming(false)
    void removeApp(app.id)
  }

  let row: React.ReactNode
  if (state.installState === 'installing') {
    row = (
      <>
        <span className="shelf-progress" role="progressbar" aria-label={`Installing ${app.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ width: `${percent}%` }} />
        </span>
        <span className="shelf-note">Installing · {percent}%</span>
      </>
    )
  } else if (state.installState === 'installed' && confirming) {
    row = (
      <>
        <span className="shelf-note shelf-ask">{app.name} is open; unsaved work in it is lost.</span>
        <button type="button" className="shelf-btn is-danger" aria-label={`Remove ${app.name} now`} onClick={remove}>Remove</button>
        <button type="button" className="shelf-btn is-quiet" onClick={() => setConfirming(false)}>Keep</button>
      </>
    )
  } else if (state.installState === 'installed') {
    row = (
      <>
        <button type="button" className="shelf-btn" data-nav="app" aria-label={`Open ${app.name}`} onClick={() => void go('app', { id: app.id })}>Open</button>
        <button type="button" className="shelf-btn is-quiet" aria-label={`Remove ${app.name}`} onClick={remove}>Remove</button>
        <span className="shelf-note shelf-right">Installed{app.installedVersion ? ` · ${app.installedVersion}` : ''}</span>
      </>
    )
  } else if (state.installState === 'failed') {
    row = (
      <>
        <button type="button" className="shelf-btn is-primary" aria-label={`Retry installing ${app.name}`} onClick={() => void installApp(app.id)}>Retry</button>
        <span className="shelf-note shelf-right">{sizeText(app.sizeBytes)}</span>
      </>
    )
  } else {
    row = (
      <>
        <button type="button" className="shelf-btn" aria-label={`Install ${app.name}`} onClick={() => void installApp(app.id)}>Install</button>
        <span className="shelf-note shelf-right">{sizeText(app.sizeBytes)}</span>
      </>
    )
  }

  return (
    <article className={`shelf-card is-${state.installState}`} data-app={app.id} aria-label={app.name}>
      <AppIcon app={app} size={32} />
      <div className="shelf-body">
        <div className="shelf-name">{app.name}</div>
        <small className="shelf-like">like {app.likeName}</small>
        <div className="shelf-what">{app.description}</div>
        {state.installState === 'failed' && (
          <p className="shelf-error" role="alert">{state.error ?? `${app.name} could not be installed. Check your connection and press Retry.`}</p>
        )}
        <div className="shelf-row">{row}</div>
      </div>
    </article>
  )
}

export function Shelf() {
  const craft = useApp((state) => state.craft)
  const installed = craft.apps.filter((app) => isInstalled({ craft }, app.id))
  const bytes = installed.reduce((sum, app) => sum + app.sizeBytes, 0)
  return (
    <section className="shelf" aria-label="Apps shelf">
      <header className="shelf-head">
        <h2>Apps</h2>
        <p>Install only what you use. Each can be removed again.</p>
        <span className="shelf-disk">{installed.length ? `${installed.length} installed · ${sizeText(bytes)} on disk` : 'Nothing installed yet'}</span>
      </header>
      {craft.error && <p className="shelf-error">{craft.error}</p>}
      {!craft.loaded && <p className="shelf-empty">Reading the app catalog…</p>}
      <div className="shelf-grid">
        {craft.apps.map((app) => <ShelfCard key={app.id} app={app} />)}
      </div>
    </section>
  )
}
