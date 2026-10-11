// The renderer's line to the Craft apps: the catalog, installs, and the docked app window that
// main lays over the right side's app region. Main owns the apps and their windows; the UI only
// asks for them and reports where the region is, as BrowserPanel.tsx does for the browser's page.
// The bridge's contract is CraftBridge in src/shared/types.ts; the preload exposes it.

import type { CraftBridge, CraftState } from '../../shared/types.ts'

export type { CraftAppInfo, CraftBounds, CraftBridge, CraftState } from '../../shared/types.ts'

declare global {
  interface Window {
    craft?: CraftBridge
    /**
     * A stand-in for `window.craft` that a UI check installs before the page loads
     * (tests/ui/craft-fake.ts). The preload's bridge cannot be replaced, so the fake has its own name.
     */
    __craftFake?: CraftBridge
  }
}

const UNAVAILABLE = 'The app manager is not available in this build. Restart Craft Studio, and if it persists, reinstall it.'

/** The bridge, or one that refuses everything when main has none, so the shelf can say so. */
export function craft(): CraftBridge {
  const bridge = window.__craftFake ?? window.craft
  if (bridge) return bridge
  const refuse = (): Promise<never> => Promise.reject(new Error(UNAVAILABLE))
  return { catalog: refuse, install: refuse, remove: refuse, show: refuse, setBounds: refuse, hide: async () => {}, onState: () => () => {} }
}

/**
 * The shelf's order (docs/mockups/craft-shelf.html): the creative apps first, then the work apps,
 * so all twelve fill a 4 × 3 grid. An app not named here goes at the end, in the catalog's order.
 */
export const SHELF_ORDER = [
  'photocraft', 'vectorcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft', 'soundcraft',
  'wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft', 'cadcraft'
] as const

export function shelfOrder<T extends { id: string }>(apps: readonly T[]): T[] {
  const rank = (id: string): number => {
    const index = (SHELF_ORDER as readonly string[]).indexOf(id)
    return index < 0 ? SHELF_ORDER.length : index
  }
  // Array.prototype.sort is stable, so unknown apps keep the catalog's order among themselves.
  return [...apps].sort((a, b) => rank(a.id) - rank(b.id))
}

/** "72 MB", "1.2 GB": the shelf's sizes. */
export function sizeText(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / 1_000_000
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`
  return `${Math.max(1, Math.round(mb))} MB`
}

/** An app is running whenever it has a process, shown or not; the dock marks it with a dot. */
export function isRunning(state: CraftState | undefined): boolean {
  return !!state && state.run !== 'stopped'
}
