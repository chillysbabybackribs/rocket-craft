// The renderer's line to the Craft apps: the catalog, installs, and the docked app window that
// main lays over the right side's app region. Main owns the apps and their windows; the UI only
// asks for them and reports where the region is, as BrowserPanel.tsx does for the browser's page.
// The bridge's contract is CraftBridge in src/shared/types.ts; the preload exposes it.

import type { CraftAppInfo, CraftBridge, CraftState } from '../../shared/types.ts'

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

/** Two letters for an app's icon until the real icons are used: the manifest's, else "Ph" for PhotoCraft. */
export function initialsOf(app: Pick<CraftAppInfo, 'initials' | 'shortName' | 'name'>): string {
  if (app.initials) return app.initials
  const word = (app.shortName || app.name).replace(/[^A-Za-z0-9]/g, '')
  return word.slice(0, 1).toUpperCase() + word.slice(1, 2).toLowerCase()
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
