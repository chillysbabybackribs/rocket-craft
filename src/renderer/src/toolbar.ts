// The toolbar's sections: the rail's four destinations, which the user can rename, reorder, keep
// in the toolbar for good, or consolidate into the drawer that slides out of the Sections icon
// (docs/mockups/titlebar-nav-drawer-mac.html). A name is only a label: the section's id, the app
// map and what a screen reader hears all keep the real name, so a model asked to open the tool
// ledger still finds it.

export type SectionId = 'chats' | 'library' | 'tools' | 'browser'

/** Menus open a list under their button; panels take the side column, one at a time. */
export const SECTIONS: Record<SectionId, { name: string; kind: 'menu' | 'panel' }> = {
  chats: { name: 'Chats', kind: 'menu' },
  library: { name: 'Library', kind: 'panel' },
  tools: { name: 'Tools', kind: 'panel' },
  browser: { name: 'Browser', kind: 'panel' }
}

export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[]

/** Long enough for a word or two; the toolbar has no room for more. */
export const NAME_MAX = 24

export type ToolbarPrefs = {
  /** Whether the drawer stands open. */
  open: boolean
  /** Every section, in the order the user put them. */
  order: SectionId[]
  /** Sections shown in the toolbar at all times; the rest live in the drawer. */
  kept: SectionId[]
  /** Labels the user gave, by section. */
  names: Partial<Record<SectionId, string>>
}

export const DEFAULT_TOOLBAR: ToolbarPrefs = { open: false, order: [...SECTION_IDS], kept: [], names: {} }

function isSection(value: unknown): value is SectionId {
  return typeof value === 'string' && Object.hasOwn(SECTIONS, value)
}

// Sections that were renamed: preferences saved under the old id keep their place, their pin and
// their label. The Evals section became Tools when the eval scenarios were removed and only the
// tool ledger was left in it.
const RENAMED: Record<string, SectionId> = { evals: 'tools' }

function current(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(RENAMED, value) ? RENAMED[value] : value
}

/** Saved preferences as they can be trusted: unknown ids dropped, missing sections added at the end. */
export function normalizeToolbar(saved: unknown): ToolbarPrefs {
  const record = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {}
  const listed = Array.isArray(record.order) ? record.order.map(current).filter(isSection) : []
  const order = [...new Set([...listed, ...SECTION_IDS])]
  const kept = Array.isArray(record.kept) ? [...new Set(record.kept.map(current).filter(isSection))] : []
  const names: Partial<Record<SectionId, string>> = {}
  if (record.names && typeof record.names === 'object') {
    for (const [saved, name] of Object.entries(record.names as Record<string, unknown>)) {
      const id = current(saved)
      if (isSection(id) && typeof name === 'string' && !names[id]) {
        const clean = cleanName(id, name)
        if (clean) names[id] = clean
      }
    }
  }
  return { open: record.open === true, order, kept, names }
}

/** A typed name as it is kept: trimmed and capped, or nothing when it is blank or the default. */
export function cleanName(id: SectionId, name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
  return clean && clean !== SECTIONS[id].name ? clean : null
}

export function labelOf(prefs: ToolbarPrefs, id: SectionId): string {
  return prefs.names[id] ?? SECTIONS[id].name
}

/** What a screen reader hears: the label, with the real name after it when the two differ. */
export function accessibleName(prefs: ToolbarPrefs, id: SectionId): string {
  const label = labelOf(prefs, id)
  return label === SECTIONS[id].name ? label : `${label} (${SECTIONS[id].name})`
}

export function rename(prefs: ToolbarPrefs, id: SectionId, name: string): ToolbarPrefs['names'] {
  const names = { ...prefs.names }
  const clean = cleanName(id, name)
  if (clean) names[id] = clean
  else delete names[id]
  return names
}

export function setKept(prefs: ToolbarPrefs, id: SectionId, keep: boolean): SectionId[] {
  const kept = prefs.kept.filter((each) => each !== id)
  return keep ? [...kept, id] : kept
}

/** The order with `id` moved to just before `before`, or to the end when `before` is null. */
export function moveSection(order: SectionId[], id: SectionId, before: SectionId | null): SectionId[] {
  if (id === before) return order
  const rest = order.filter((each) => each !== id)
  const at = before ? rest.indexOf(before) : -1
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The sections in order, split into the ones the toolbar keeps and the ones in the drawer. */
export function arrange(prefs: ToolbarPrefs): { kept: SectionId[]; drawer: SectionId[] } {
  return {
    kept: prefs.order.filter((id) => prefs.kept.includes(id)),
    drawer: prefs.order.filter((id) => !prefs.kept.includes(id))
  }
}
