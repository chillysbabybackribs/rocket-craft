import { Globe, LayoutGrid, LibraryBig, X } from 'lucide-react'
import { act, go } from '../app-map.ts'
import { CraftIcon } from '../craft-icons.tsx'
import { closeOpenApp, setBrowserOpen, setLibraryOpen, showApp, sideShown, useApp } from '../store.ts'

// The right side's section switcher (docs/mockups/craft-studio.html): Apps opens the shelf; each
// opened app gets a tab between Apps and Browser so you can move among apps, the browser and the
// library. A tab's × removes the app from the nav (and hides it when it was shown).

export function SideNav() {
  const side = useApp(sideShown)
  const openApps = useApp((state) => state.openApps)
  const apps = useApp((state) => state.craft.apps)
  const appsOn = side?.kind === 'shelf'
  const browser = side?.kind === 'browser'
  const library = side?.kind === 'library'
  const shownApp = side?.kind === 'app' ? side.id : null
  return (
    <nav className="side-nav" aria-label="Right side">
      <button
        type="button"
        className={`side-nav-item${appsOn ? ' is-on' : ''}`}
        data-nav="shelf"
        aria-label="Apps"
        aria-pressed={appsOn}
        onClick={() => void act('shelf.open')}
      >
        <LayoutGrid size={15} aria-hidden />
        <span>Apps</span>
      </button>
      {openApps.length > 0 && (
        <div className="side-nav-apps" role="group" aria-label="Open apps">
          {openApps.map((id) => {
            const app = apps.find((entry) => entry.id === id)
            if (!app) return null
            const on = shownApp === id
            return (
              <div key={id} className={`side-nav-app${on ? ' is-on' : ''}`} data-app={id}>
                <button
                  type="button"
                  className="side-nav-app-main"
                  data-nav="app"
                  aria-label={app.name}
                  aria-pressed={on}
                  onClick={() => showApp(id)}
                >
                  <CraftIcon app={app} size={18} />
                  <span className="side-nav-app-name">{app.name}</span>
                </button>
                <button
                  type="button"
                  className="side-nav-app-close"
                  aria-label={`Close ${app.name}`}
                  onClick={() => closeOpenApp(id)}
                >
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        className={`side-nav-item${browser ? ' is-on' : ''}`}
        data-nav="browser"
        aria-label="Browser"
        aria-pressed={browser}
        onClick={() => (browser ? setBrowserOpen(false) : void go('browser'))}
      >
        <Globe size={15} aria-hidden />
        <span>Browser</span>
      </button>
      <button
        type="button"
        className={`side-nav-item${library ? ' is-on' : ''}`}
        data-nav="library"
        aria-label="Library"
        aria-pressed={library}
        onClick={() => (library ? setLibraryOpen(false) : void go('library'))}
      >
        <LibraryBig size={15} aria-hidden />
        <span>Library</span>
      </button>
    </nav>
  )
}
