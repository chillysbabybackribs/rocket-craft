import { Globe, LayoutGrid, LibraryBig } from 'lucide-react'
import { act, go } from '../app-map.ts'
import { setBrowserOpen, setLibraryOpen, sideShown, useApp } from '../store.ts'

// The right side's section switcher (docs/mockups/craft-studio.html): Apps opens the shelf, Browser
// and Library toggle their panels. It sits above the browser tabs when the browser is shown, and
// at the top of the right column for every other view.

export function SideNav() {
  const side = useApp(sideShown)
  const apps = side?.kind === 'shelf'
  const browser = side?.kind === 'browser'
  const library = side?.kind === 'library'
  return (
    <nav className="side-nav" aria-label="Right side">
      <button
        type="button"
        className={`side-nav-item${apps ? ' is-on' : ''}`}
        data-nav="shelf"
        aria-label="Apps"
        aria-pressed={apps}
        onClick={() => void act('shelf.open')}
      >
        <LayoutGrid size={15} aria-hidden />
        <span>Apps</span>
      </button>
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
