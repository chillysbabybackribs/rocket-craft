// A stand-in for the preload's `window.craft`, for UI checks that must not download or start real
// apps. It is installed as `window.__craftFake` by an init script (the renderer prefers it, see
// src/renderer/src/craft.ts), records every call in `__craftFake.calls`, and lets the spec drive
// what main would report: install progress, a finished or failed install, an app that has started.

import type { Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'

/** The catalog as the mockup has it; sizes are the upstream Linux download sizes it quotes. */
export const FAKE_CATALOG = [
  ['photocraft', 'PhotoCraft', 'Photoshop', 'Photo', '#1f6feb', 'Photos, layers, masks, PSD', 72],
  ['vectorcraft', 'VectorCraft', 'Illustrator', 'Vector', '#d9822b', 'Logos, paths, illustration', 79],
  ['filmcraft', 'FilmCraft', 'Premiere Pro', 'Film', '#7c3aed', 'Video editing and timelines', 64],
  ['lightcraft', 'LightCraft', 'Lightroom', 'Light', '#0e9fb8', 'Photo library and RAW develop', 93],
  ['pdfcraft', 'PdfCraft', 'Acrobat', 'PDF', '#d93f3f', 'Read, sign, combine PDFs', 78],
  ['effectcraft', 'EffectCraft', 'After Effects', 'Effect', '#a855f7', 'Motion graphics, compositing', 58],
  ['designcraft', 'DesignCraft', 'InDesign', 'Design', '#e0457b', 'Page layout, magazines, books', 67],
  ['soundcraft', 'SoundCraft', 'Pro Tools', 'Sound', '#16a34a', 'Multitrack audio and mixing', 14],
  ['deckcraft', 'DeckCraft', 'PowerPoint', 'Deck', '#ea580c', 'Slides and presentations', 71],
  ['cadcraft', 'CADCraft', 'AutoCAD', 'CAD', '#0284c7', '2D drafting and plans', 21],
  ['wordcraft', 'WordCraft', 'Word', 'Word', '#2563eb', 'Documents and letters', 85],
  ['gridcraft', 'GridCraft', 'Excel', 'Grid', '#15803d', 'Spreadsheets and charts', 16]
] as const

export type FakeCall = { method: string; args: unknown[] }

/** The init script's body; it runs in every page before its own scripts. */
function install(catalog: typeof FAKE_CATALOG): void {
  type State = { id: string; installState: string; progress?: number; run: string; error?: string }
  const apps = catalog.map(([id, name, likeName, shortName, accent, description, mb]) => ({
    id, name, likeName, shortName, initials: '', accent, description, repo: `storytold/${id}`, version: '0.7.0', extensions: [],
    downloadBytes: mb * 1_000_000, sizeBytes: mb * 1_000_000, installed: false, installedVersion: null as string | null
  }))
  const listeners = new Set<(state: State) => void>()
  const states = new Map<string, State>()
  const calls: Array<{ method: string; args: unknown[] }> = []
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  let shown: string | null = null
  const emit = (state: State): void => {
    states.set(state.id, state)
    for (const listener of listeners) listener(state)
  }
  const stateOf = (id: string): State => states.get(id) ?? { id, installState: apps.find((app) => app.id === id)?.installed ? 'installed' : 'none', run: 'stopped' }
  const record = (method: string, ...args: unknown[]): void => { calls.push({ method, args: JSON.parse(JSON.stringify(args)) }) }
  const fake = {
    calls,
    catalog: async () => { record('catalog'); return apps.map((app) => ({ ...app })) },
    install: (id: string) => {
      record('install', id)
      emit({ id, installState: 'installing', progress: 0, run: 'stopped' })
      return new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    remove: async (id: string) => {
      record('remove', id)
      const app = apps.find((entry) => entry.id === id)!
      app.installed = false
      app.installedVersion = null
      if (shown === id) shown = null
      emit({ id, installState: 'none', run: 'stopped' })
    },
    show: async (id: string, bounds: unknown) => {
      record('show', id, bounds)
      if (shown && shown !== id) emit({ ...stateOf(shown), run: 'resting' })
      shown = id
      const state = stateOf(id)
      emit({ ...state, run: state.run === 'stopped' ? 'starting' : 'shown' })
    },
    setBounds: async (bounds: unknown) => { record('setBounds', bounds) },
    hide: async () => {
      record('hide')
      if (shown) emit({ ...stateOf(shown), run: 'resting' })
      shown = null
    },
    onState: (listener: (state: State) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // The spec's controls, standing in for main.
    progress: (id: string, progress: number) => emit({ id, installState: 'installing', progress, run: 'stopped' }),
    finish: (id: string) => {
      const app = apps.find((entry) => entry.id === id)!
      app.installed = true
      app.installedVersion = '0.7.0'
      emit({ id, installState: 'installed', run: 'stopped' })
      pending.get(id)?.resolve()
      pending.delete(id)
    },
    fail: (id: string, error: string) => {
      emit({ id, installState: 'failed', run: 'stopped', error })
      pending.get(id)?.reject(new Error(error))
      pending.delete(id)
    },
    run: (id: string, run: string) => emit({ ...stateOf(id), run })
  }
  Object.defineProperty(window, '__craftFake', { value: fake, configurable: true })
}

/** Install the fake in every page of the app, then reload the shell so it starts with the fake. */
export async function useFakeCraft(app: ElectronApplication, page: Page): Promise<void> {
  await app.context().addInitScript({ content: `(${install.toString()})(${JSON.stringify(FAKE_CATALOG)})` })
  await page.reload()
  await page.waitForFunction(() => '__craftFake' in window)
}

/** Every call the renderer made to the fake so far. */
export async function craftCalls(page: Page): Promise<FakeCall[]> {
  return page.evaluate(() => (window as unknown as { __craftFake: { calls: FakeCall[] } }).__craftFake.calls)
}

/** Run one of the fake's controls (progress, finish, fail, run) in the page. */
export async function craftControl(page: Page, method: 'progress' | 'finish' | 'fail' | 'run', ...args: unknown[]): Promise<void> {
  await page.evaluate(({ method, args }) => {
    const fake = (window as unknown as { __craftFake: Record<string, (...rest: unknown[]) => void> }).__craftFake
    fake[method]!(...args)
  }, { method, args })
}
