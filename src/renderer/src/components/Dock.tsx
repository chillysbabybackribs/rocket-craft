import { useMemo } from 'react'
import { Globe, LibraryBig, Plus } from 'lucide-react'
import { act, go } from '../app-map.ts'
import { initialsOf, isRunning, type CraftAppInfo } from '../craft.ts'
import { craftStateOf, dockApps, setBrowserOpen, setLibraryOpen, sideShown, useApp } from '../store.ts'

// The dock under the right side (docs/mockups/craft-studio.html): the installed apps, each an icon
// with its short name under it, then + Add for the shelf, a divider, and the Browser and Library
// toggles at its right end. The shown one has a bar along its top edge; a running app has a green
// dot. An app installing sits here already, dimmed, with its progress across the icon.
//
// Nothing here opens upward or shows a hover tooltip: the docked app window above is a native
// window that paints over anything drawn across it.

/** An app's icon: its initials on its colour, until the release icons are used. */
export function AppIcon({ app, size = 28 }: { app: CraftAppInfo; size?: number }) {
  return (
    <span className="craft-icon" style={{ background: app.accent, width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden>
      {initialsOf(app)}
    </span>
  )
}

function DockApp({ app, on }: { app: CraftAppInfo; on: boolean }) {
  const state = useApp((current) => craftStateOf(current, app.id))
  const installing = state.installState === 'installing'
  const percent = Math.round((state.progress ?? 0) * 100)
  return (
    <button
      type="button"
      className={`dock-item${on ? ' is-on' : ''}${isRunning(state) ? ' is-running' : ''}${installing ? ' is-installing' : ''}`}
      data-app={app.id}
      data-nav="app"
      aria-label={installing ? `${app.name}, installing ${percent}%` : app.name}
      aria-pressed={on}
      onClick={() => void (installing ? act('shelf.open') : act('app.show', { id: app.id }))}
    >
      <span className="dock-icon">
        <AppIcon app={app} />
        {installing && <span className="dock-progress" style={{ '--progress': `${percent}%` } as React.CSSProperties} />}
      </span>
      <span className="dock-label">{app.shortName}</span>
    </button>
  )
}

export function Dock() {
  const craft = useApp((state) => state.craft)
  const side = useApp(sideShown)
  // The dock's list is worked out from the catalog and the states, which change only together with `craft`.
  const apps = useMemo(() => dockApps({ craft }), [craft])
  const browser = side?.kind === 'browser'
  const library = side?.kind === 'library'
  return (
    <nav className="dock" aria-label="Apps dock">
      {apps.map((app) => <DockApp key={app.id} app={app} on={side?.kind === 'app' && side.id === app.id} />)}
      <button
        type="button"
        className={`dock-item dock-add${side?.kind === 'shelf' ? ' is-on' : ''}`}
        data-nav="shelf"
        aria-label="Add apps"
        aria-pressed={side?.kind === 'shelf'}
        onClick={() => void act('shelf.open')}
      >
        <span className="dock-tool"><Plus size={16} aria-hidden /></span>
        <span className="dock-label">Add</span>
      </button>
      <span className="dock-fill" />
      <span className="dock-sep" aria-hidden />
      <button
        type="button"
        className={`dock-item${browser ? ' is-on' : ''}`}
        data-nav="browser"
        aria-label="Browser"
        aria-pressed={browser}
        onClick={() => (browser ? setBrowserOpen(false) : void go('browser'))}
      >
        <span className="dock-tool"><Globe size={15} aria-hidden /></span>
        <span className="dock-label">Browser</span>
      </button>
      <button
        type="button"
        className={`dock-item${library ? ' is-on' : ''}`}
        data-nav="library"
        aria-label="Library"
        aria-pressed={library}
        onClick={() => (library ? setLibraryOpen(false) : void go('library'))}
      >
        <span className="dock-tool"><LibraryBig size={15} aria-hidden /></span>
        <span className="dock-label">Library</span>
      </button>
    </nav>
  )
}
