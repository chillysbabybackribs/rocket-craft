import { CRAFT_APPS } from '../../shared/craft-apps.ts'

// How each Craft app's control channel is driven: the one place the twelve apps' differences live,
// so the craft_* tools keep one schema for all of them. Launch flags, tokens and roots are in
// `src/shared/craft-apps.ts`; this is what happens on the wire once the app runs.
//
// Transport: every app is driven over its own loopback control channel, straight from the agent
// host. The CLIs' `mcp --bridge/--connect` servers wrap the same methods, but each would be one more
// process per app, and PdfCraft 0.6.0 has none at all.
//
// Sources: each app's docs/control-protocol.md and crates/ui-egui/src/control.rs (plus its command
// and save code) at its pinned tag, read 2026-10-11. Live-checked the same day against GridCraft
// 0.5.0 and PhotoCraft 0.7.0 on a private Xvfb display; the other ten are from their source only:
// see `checked`.
//
// - Most apps: `{id, method, params}` per line, `{id, ok, result | error}` back; any engine command
//   through `engine.execute {command, params}`; `engine.commands` lists them all.
// - PhotoCraft 0.7.0: `auth {token}` first on every connection; closes an authenticated connection
//   after 30 s idle (measured: 30.3 s). `document.inspect` is an engine command, not a method.
//   `app.open` / `app.save` read and write only under the roots it was started with (absolute paths
//   inside them are accepted, checked live). `ui.screenshot` raises the window unless `focus: false`.
//   `engine.commands` has no search and answers 858 commands (215 KB).
// - GridCraft 0.5.0: `engine.commands {search}` filters in the app; `ui.screenshot` without a path
//   answers `{base64}`; `app.save {path}` picks the format from the extension (xlsx, csv checked).
// - VectorCraft 0.9.0: `ui.screenshot` answers base64 (`pngBase64`) only with `data: true` and raises
//   the window unless `focus: false`; a save to .svg without `svg` options opens a dialog.
// - FilmCraft 0.6.0, EffectCraft 0.8.0: no document.inspect (`project.inspect`, `project.summary`
//   engine commands); `ui.screenshot` writes a file and raises the window (without taking focus).
// - LightCraft 0.6.0: a photo library, not documents: "open" imports into it, nothing is saved (every
//   change is journaled), files leave by export. Screenshots need a path.
// - PdfCraft 0.6.0: JSON-RPC 2.0; port and token from the control file it writes; commands run with
//   `ui.command {id}` and take no params; it can only save a document back to its own file.
// - DesignCraft, CADCraft, WordCraft: `ui.screenshot` writes a file (no base64). DeckCraft answers
//   base64 as `png`, SoundCraft as `png_base64`.
// - WordCraft 0.5.0: `{method: "auth", key}` with the key at the top level, once per connection.
// - Saving a never-saved document without a path opens a native Save As dialog in VectorCraft,
//   FilmCraft, DeckCraft, WordCraft and PdfCraft, which no model can answer: such saves are refused
//   unless the document has a file (`ownNeedsFile`).

export type CraftWireAuth =
  | { kind: 'none' }
  /** The token in the launch's token file, sent as `{method, params: {[field]: token}}`. */
  | { kind: 'token'; method: string; field: string }
  /** A key the app writes under its XDG_CONFIG_HOME, sent as `{method, [field]: key}`. */
  | { kind: 'key'; method: string; field: string; path: string }
  /** The token in the control file the app writes (PdfCraft), sent as `{method, params: {[field]: token}}`. */
  | { kind: 'controlFile'; method: string; field: string }

/** A control request: `method` with fixed `params`; through `execute` when it is an engine command. */
export type CraftCall = { method: string; params?: Record<string, unknown>; viaEngine?: boolean }
/** A call that takes a file: its path goes in `pathField`, as a one-item list when `asList`. */
export type CraftFileCall = CraftCall & { pathField: string; asList?: boolean }
/** A call that writes some formats: `formats` empty means whatever the extension says. */
export type CraftWriteCall = CraftFileCall & { formats: string[]; formatField: string | null; paramsFor?: Record<string, Record<string, unknown>> }

export type CraftAdapter = {
  id: string
  framing: 'lines' | 'jsonrpc'
  auth: CraftWireAuth
  /** The app closes a connection idle this long; the host opens a fresh one first. */
  idleCloseMs: number | null
  /** How an engine command runs: `{method, params: {[commandField]: id, [paramsField]: params}}`; no params when `paramsField` is null. */
  execute: { method: string; commandField: string; paramsField: string | null }
  /** The command list, and the param that filters it in the app when there is one. */
  commands: { method: string; search: string | null }
  /** The document's state for craft_inspect. */
  inspect: CraftCall
  /** The UI's state (tool, dialogs, panels) for craft_inspect {what: "ui"}. */
  ui: CraftCall
  /** Short state for the situation line and craft_apps, and the document's own file before a save. */
  brief: CraftCall
  open: CraftFileCall | null
  save: {
    /** Back to the document's own file. */
    own: CraftCall | null
    /** Without a file of its own the app would open a native dialog, so `own` needs `fileFields` to find one. */
    ownNeedsFile: boolean
    /** To a path, in the app's own formats. */
    to: CraftWriteCall | null
  }
  /** Formats the app writes beside its own (an image of a document, a mixdown of a session). */
  exports: CraftWriteCall[]
  /** Only under the folder the app was started with (its automation roots). */
  paths: 'any' | 'roots'
  /** `inline`: the PNG comes back base64; `path`: the app writes it to a file we name. */
  screenshot: CraftCall & { returns: 'inline' | 'path' }
  /** Control methods a model may call by name through craft_run; any other name is an engine command. */
  methods: string[]
  /** Names refused through craft_run, with what to do instead. */
  refused: Record<string, string>
  /** Where the document's name is in `brief`'s result, first match wins (`a.b`, `list[active].name`). */
  documentFields: string[]
  /** Where the document's own file is in `brief`'s result. */
  fileFields: string[]
  /** The date this entry was run against the real app, or null when it is only read from source. */
  checked: string | null
}

const QUIT = 'Craft Studio never closes an app for a model; only the user closes apps.'
const WINDOW = 'Craft Studio places the app’s window itself; resizing or raising it from a model would break the dock.'
const FILES = 'Use craft_open and craft_save, which check the path and never open a file dialog.'
const DIALOG = 'it opens a native file or print dialog, which a model cannot answer. Ask the user, or use craft_open and craft_save.'

/** Refusals every app shares. */
const REFUSED: Record<string, string> = {
  'app.quit': QUIT, 'app.exit': QUIT, 'file.exit': QUIT, 'file.quit': QUIT,
  'ui.resize': WINDOW, 'ui.focus': WINDOW, 'ui.window.close': WINDOW, 'ui.zoomFactor': WINDOW,
  'app.open': FILES, 'app.save': FILES, 'app.export': FILES, 'file.open': FILES, 'file.save': FILES, 'file.saveAs': FILES,
  'file.saveACopy': FILES, 'file.saveCopy': FILES, 'file.save_as': FILES, 'session.open': FILES, 'session.save': FILES,
  'session.save_as': FILES, 'app.openLibrary': FILES, 'file.print': `file.print: ${DIALOG}`, 'print.dialog': `print.dialog: ${DIALOG}`,
  'app.openDialog': `app.openDialog: ${DIALOG}`, 'app.saveDialog': `app.saveDialog: ${DIALOG}`, 'app.saveCopyDialog': `app.saveCopyDialog: ${DIALOG}`,
  'app.placeDialog': `app.placeDialog: ${DIALOG}`
}

const UI_METHODS = ['ui.inspect', 'ui.click', 'ui.move', 'ui.drag', 'ui.key', 'ui.text', 'ui.set', 'ui.menu.list', 'ui.menu.invoke',
  'ui.dialog.open', 'ui.dialog.set', 'ui.dialog.confirm', 'ui.dialog.cancel']

const EXECUTE = { method: 'engine.execute', commandField: 'command', paramsField: 'params' }
const LINES = { framing: 'lines' as const, auth: { kind: 'none' as const }, idleCloseMs: null, execute: EXECUTE }
const ENGINE_COMMANDS = { method: 'engine.commands', search: null }
const SHOT_INLINE = { method: 'ui.screenshot', params: {}, returns: 'inline' as const }
const SHOT_PATH = { method: 'ui.screenshot', params: {}, returns: 'path' as const }
const OPEN = { method: 'app.open', pathField: 'path' }
const SAVE_OWN = { method: 'app.save' }
const TITLE_PATH = { documentFields: ['path', 'title', 'name'], fileFields: ['path'] }

function adapter(entry: Omit<CraftAdapter, 'refused'> & { refused?: Record<string, string> }): CraftAdapter {
  return { ...entry, refused: { ...REFUSED, ...entry.refused } }
}

export const CRAFT_ADAPTERS: Record<string, CraftAdapter> = Object.fromEntries([
  adapter({
    id: 'photocraft', framing: 'lines', auth: { kind: 'token', method: 'auth', field: 'token' }, idleCloseMs: 30_000, execute: EXECUTE,
    commands: ENGINE_COMMANDS,
    inspect: { method: 'document.inspect', viaEngine: true }, ui: { method: 'ui.inspect' }, brief: { method: 'document.inspect', viaEngine: true },
    open: OPEN,
    // app.save without a path writes only back to the document's own PSD, PSB or .pcraft and
    // otherwise fails: no dialog.
    save: { own: SAVE_OWN, ownNeedsFile: false, to: { method: 'app.save', pathField: 'path', formats: [], formatField: null } },
    exports: [], paths: 'roots',
    screenshot: { method: 'ui.screenshot', params: { focus: false }, returns: 'inline' },
    methods: [...UI_METHODS, 'ui.pointer', 'ui.type', 'ui.context.choose', 'ui.dialog.apply', 'jobs.list', 'jobs.cancel'],
    documentFields: ['path', 'name'], fileFields: ['path'],
    checked: '2026-10-11'
  }),
  adapter({
    ...LINES, id: 'vectorcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'document.inspect', params: { depth: 2, childLimit: 50 } }, ui: { method: 'ui.inspect' }, brief: { method: 'document.inspect', params: { depth: 0 } },
    open: OPEN,
    save: {
      own: SAVE_OWN, ownNeedsFile: true,
      to: { method: 'app.save', pathField: 'path', formats: ['vectorcraft', 'template', 'pdf', 'svg', 'svgz'], formatField: 'format', paramsFor: { svg: { svg: {} }, svgz: { svg: {} } } }
    },
    exports: [{ method: 'app.export', pathField: 'path', formats: ['png', 'jpg', 'jpeg', 'webp', 'png8', 'gif', 'txt'], formatField: 'format' }],
    paths: 'roots',
    screenshot: { method: 'ui.screenshot', params: { focus: false, data: true }, returns: 'inline' },
    methods: [...UI_METHODS, 'ui.pointer', 'ui.tool.select', 'ui.render', 'document.node', 'document.formats'],
    ...TITLE_PATH, checked: null
  }),
  adapter({
    ...LINES, id: 'filmcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'project.inspect', viaEngine: true }, ui: { method: 'ui.inspect' }, brief: { method: 'project.inspect', viaEngine: true },
    open: { method: 'file.open', pathField: 'path', viaEngine: true },
    save: { own: { method: 'file.save', viaEngine: true }, ownNeedsFile: true, to: { method: 'file.saveAs', pathField: 'path', formats: ['fcproj'], formatField: null, viaEngine: true } },
    exports: [{ method: 'file.exportMedia', pathField: 'path', formats: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mxf', 'wav', 'png'], formatField: null, viaEngine: true }],
    paths: 'any', screenshot: SHOT_PATH,
    methods: [...UI_METHODS, 'ui.elements', 'ui.panel.show', 'ui.panel.close', 'perf.stats'],
    ...TITLE_PATH, checked: null
  }),
  adapter({
    ...LINES, id: 'lightcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'library.info', viaEngine: true }, ui: { method: 'ui.inspect' }, brief: { method: 'library.info', viaEngine: true },
    // A photo library: opening a photo imports it, and the first new photo becomes the active one.
    open: { method: 'library.import', pathField: 'paths', asList: true, params: { mode: 'add' }, viaEngine: true },
    save: { own: null, ownNeedsFile: false, to: null },
    exports: [{ method: 'app.export', pathField: 'path', formats: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'dng', 'avif', 'heic'], formatField: 'format', viaEngine: true }],
    paths: 'any', screenshot: SHOT_PATH,
    methods: [...UI_METHODS, 'ui.clipboard', 'ui.widgets'],
    documentFields: ['path'], fileFields: ['path'], checked: null
  }),
  adapter({
    id: 'pdfcraft', framing: 'jsonrpc', auth: { kind: 'controlFile', method: 'auth', field: 'token' }, idleCloseMs: null,
    execute: { method: 'ui.command', commandField: 'id', paramsField: null },
    commands: { method: 'ui.commands', search: null },
    inspect: { method: 'ui.state' }, ui: { method: 'ui.inspect', params: { limit: 300 } }, brief: { method: 'ui.state' },
    open: { method: 'ui.open', pathField: 'path' },
    // Only back to the document's own file: Save As always asks with a native dialog.
    save: { own: { method: 'ui.command', params: { id: 'file.save' } }, ownNeedsFile: true, to: null },
    exports: [], paths: 'any',
    screenshot: { method: 'ui.screenshot', params: {}, returns: 'inline' },
    methods: ['ui.state', 'ui.inspect', 'ui.set', 'ui.click', 'ui.move', 'ui.drag', 'ui.type', 'ui.key'],
    refused: Object.fromEntries(['file.pin_folder', 'create.file', 'create.multiple', 'create.images'].map((id) => [id, `${id}: ${DIALOG}`])),
    documentFields: ['documents[active].path', 'documents[active].name'], fileFields: ['documents[active].path'], checked: null
  }),
  adapter({
    ...LINES, id: 'effectcraft', commands: { method: 'engine.commands', search: 'filter' },
    inspect: { method: 'project.summary', viaEngine: true }, ui: { method: 'ui.inspect' }, brief: { method: 'project.summary', viaEngine: true },
    open: { method: 'file.open', pathField: 'path', viaEngine: true },
    // Through engine.execute, Save never opens a dialog: it fails without a path.
    save: { own: { method: 'file.save', viaEngine: true }, ownNeedsFile: false, to: { method: 'file.saveAs', pathField: 'path', formats: ['ecproj', 'ecprojx', 'xml'], formatField: null, viaEngine: true } },
    exports: [{ method: 'render.frame', pathField: 'path', formats: ['png'], formatField: null, viaEngine: true }],
    paths: 'any', screenshot: SHOT_PATH,
    methods: [...UI_METHODS, 'ui.panel.show', 'ui.panel.close'],
    documentFields: ['path'], fileFields: ['path'], checked: null
  }),
  adapter({
    ...LINES, id: 'designcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'document.inspect' }, ui: { method: 'ui.inspect' }, brief: { method: 'document.list', viaEngine: true },
    open: OPEN,
    save: { own: SAVE_OWN, ownNeedsFile: false, to: { method: 'app.save', pathField: 'path', formats: ['designcraft'], formatField: null } },
    exports: [
      { method: 'file.exportPdf', pathField: 'path', formats: ['pdf'], formatField: null, viaEngine: true },
      { method: 'app.export', pathField: 'path', formats: ['png'], formatField: null }
    ],
    paths: 'any',
    screenshot: { method: 'ui.screenshot', params: { focus: false }, returns: 'path' },
    methods: [...UI_METHODS, 'ui.tool.list', 'ui.tool.select', 'ui.pointer', 'ui.render'],
    documentFields: ['[active].title'], fileFields: [], checked: null
  }),
  adapter({
    ...LINES, id: 'soundcraft', commands: { method: 'engine.commands', search: 'filter' },
    inspect: { method: 'session.inspect', params: { detail: 'summary' } }, ui: { method: 'ui.inspect' }, brief: { method: 'session.inspect', params: { detail: 'summary' } },
    open: { method: 'session.open', pathField: 'path', viaEngine: true },
    save: { own: { method: 'session.save', viaEngine: true }, ownNeedsFile: false, to: { method: 'session.save_as', pathField: 'path', formats: ['scraft'], formatField: null, viaEngine: true } },
    exports: [{ method: 'file.bounce_mix', pathField: 'path', formats: ['wav', 'aiff', 'aif', 'flac'], formatField: null, viaEngine: true }],
    paths: 'any', screenshot: SHOT_INLINE,
    methods: [...UI_METHODS.filter((method) => method !== 'ui.menu.invoke'), 'engine.parity'],
    refused: { 'ui.menu.invoke': 'ui.menu.invoke in SoundCraft can open native file dialogs; run the command with craft_run instead, which never opens one.' },
    ...TITLE_PATH, checked: null
  }),
  adapter({
    ...LINES, id: 'deckcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'document.inspect' }, ui: { method: 'ui.inspect' }, brief: { method: 'document.inspect' },
    open: { method: 'file.open', pathField: 'path', viaEngine: true },
    save: { own: SAVE_OWN, ownNeedsFile: true, to: { method: 'app.save', pathField: 'path', formats: ['deckcraft', 'pptx'], formatField: 'format' } },
    exports: [{ method: 'app.export', pathField: 'path', formats: ['pdf', 'png', 'jpg', 'jpeg', 'outline'], formatField: 'format' }],
    paths: 'any', screenshot: SHOT_INLINE,
    methods: [...UI_METHODS, 'ui.tool.select', 'ui.pointer', 'ui.render', 'ui.dialog.close'],
    refused: { 'show.start': WINDOW, 'show.end': WINDOW },
    ...TITLE_PATH, checked: null
  }),
  adapter({
    ...LINES, id: 'cadcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'drawing.inspect', params: { limit: 100 } }, ui: { method: 'ui.inspect' }, brief: { method: 'drawing.inspect', params: { entities: false } },
    open: OPEN,
    save: { own: SAVE_OWN, ownNeedsFile: false, to: { method: 'app.save', pathField: 'path', formats: ['dxf', 'dwg'], formatField: null } },
    exports: [], paths: 'any', screenshot: SHOT_PATH,
    methods: [...UI_METHODS, 'cmdline.input', 'cmdline.script', 'cmdline.key', 'cmdline.state', 'ui.pointer', 'ui.render'],
    ...TITLE_PATH, checked: null
  }),
  adapter({
    framing: 'lines', auth: { kind: 'key', method: 'auth', field: 'key', path: 'wordcraft/control-key.local-{port}' }, idleCloseMs: null, execute: EXECUTE,
    id: 'wordcraft', commands: ENGINE_COMMANDS,
    inspect: { method: 'document.inspect' }, ui: { method: 'ui.inspect' }, brief: { method: 'ui.inspect' },
    open: { method: 'file.open', pathField: 'path', viaEngine: true },
    // Neither inspect says whether the document has a file, so a save always names one.
    save: { own: { method: 'file.save', viaEngine: true }, ownNeedsFile: true, to: { method: 'file.saveAs', pathField: 'path', formats: [], formatField: null, viaEngine: true } },
    exports: [
      { method: 'file.exportPdf', pathField: 'path', formats: ['pdf'], formatField: null, viaEngine: true },
      { method: 'file.exportPng', pathField: 'path', formats: ['png'], formatField: null, viaEngine: true }
    ],
    paths: 'any', screenshot: SHOT_PATH,
    methods: [...UI_METHODS, 'ui.clickText', 'ui.press', 'ui.release', 'ui.render'],
    documentFields: ['title'], fileFields: [], checked: null
  }),
  adapter({
    ...LINES, id: 'gridcraft', commands: { method: 'engine.commands', search: 'search' },
    inspect: { method: 'document.inspect' }, ui: { method: 'ui.inspect' }, brief: { method: 'document.inspect' },
    open: OPEN,
    save: { own: SAVE_OWN, ownNeedsFile: false, to: { method: 'app.save', pathField: 'path', formats: [], formatField: null } },
    exports: [], paths: 'any', screenshot: SHOT_INLINE,
    methods: [...UI_METHODS, 'engine.journal', 'sheet.read', 'cell.get', 'ui.cell.click', 'ui.cell.drag', 'ui.edit.begin', 'ui.edit.text', 'ui.edit.commit', 'ui.edit.cancel', 'ui.ribbon', 'ui.dialog'],
    documentFields: ['path', 'title'], fileFields: ['path'],
    checked: '2026-10-11'
  })
].map((entry) => [entry.id, entry]))

/** The adapter for an app id; every manifest app has one. */
export function craftAdapter(id: string): CraftAdapter | undefined {
  return CRAFT_ADAPTERS[id]
}

/** Checked at load: the table and the manifest list the same apps. */
export function adapterProblems(): string[] {
  const problems: string[] = []
  for (const app of CRAFT_APPS) if (!CRAFT_ADAPTERS[app.id]) problems.push(`${app.id} has no adapter`)
  for (const id of Object.keys(CRAFT_ADAPTERS)) if (!CRAFT_APPS.some((app) => app.id === id)) problems.push(`${id} is not in the manifest`)
  return problems
}

/** Engine commands that open a native file dialog when no file is named. */
const DIALOG_COMMAND = /^(file|app|session|project|library|captions|graphics)\.[\w.]*(open|save|import|export|place|add|load|backup|restore|locate|pick)/i
const PATH_PARAMS = ['path', 'paths', 'dir', 'folder', 'file', 'files', 'data']

/**
 * How craft_run sends `name`: as a control method when the app lists it, else as an engine command
 * through `execute`; or why it is refused.
 */
export function routeCommand(adapter: CraftAdapter, name: string, params: Record<string, unknown>): { call: CraftCall } | { refused: string } {
  const refusal = adapter.refused[name]
  if (refusal) return { refused: refusal }
  if (adapter.methods.includes(name)) return { call: { method: name, params } }
  if (DIALOG_COMMAND.test(name) && !PATH_PARAMS.some((field) => params[field] !== undefined && params[field] !== null && params[field] !== '')) {
    return { refused: `without a path ${DIALOG}` }
  }
  if (!adapter.execute.paramsField && Object.keys(params).length) return { refused: `${craftName(adapter)} commands take no params; drive its dialogs with ui.* methods.` }
  return { call: engineCall(adapter, name, params) }
}

function craftName(adapter: CraftAdapter): string {
  return CRAFT_APPS.find((app) => app.id === adapter.id)?.name ?? adapter.id
}

export function engineCall(adapter: CraftAdapter, command: string, params: Record<string, unknown> = {}): CraftCall {
  const { method, commandField, paramsField } = adapter.execute
  return { method, params: paramsField ? { [commandField]: command, [paramsField]: params } : { [commandField]: command } }
}

/** A table call as it goes on the wire: through `execute` when it is an engine command. */
export function wireCall(adapter: CraftAdapter, call: CraftCall, extra: Record<string, unknown> = {}): CraftCall {
  const params = { ...call.params, ...extra }
  return call.viaEngine ? engineCall(adapter, call.method, params) : { method: call.method, params }
}

/** A file call with its path in place. */
export function fileCall(adapter: CraftAdapter, call: CraftFileCall, path: string, extra: Record<string, unknown> = {}): CraftCall {
  return wireCall(adapter, call, { ...extra, [call.pathField]: call.asList ? [path] : path })
}

/** A value in a reply by field: `a.b` reaches into objects, `list[active]` picks the item whose `active` is true. */
export function fieldOf(result: unknown, field: string): unknown {
  let value: unknown = result
  for (const part of field.split('.')) {
    const pick = /^(\w*)\[(\w+)\]$/.exec(part)
    if (pick) {
      const list = pick[1] ? recordAt(value)?.[pick[1]] : value
      value = Array.isArray(list) ? list.find((item) => !!recordAt(item)?.[pick[2]!]) : undefined
    } else value = recordAt(value)?.[part]
  }
  return value
}

function recordAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstString(result: unknown, fields: string[]): string | null {
  for (const field of fields) {
    const value = fieldOf(result, field)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** The open document's name from a brief. */
export function documentOf(adapter: CraftAdapter, result: unknown): string | null {
  return firstString(result, adapter.documentFields)
}

/** The open document's own file from a brief, or null when it has none (or the app does not say). */
export function documentFileOf(adapter: CraftAdapter, result: unknown): string | null {
  return firstString(result, adapter.fileFields)
}

/**
 * Where a save to `ext` goes: the app's own Save As when it writes that format, else an export
 * that does; null when neither does.
 */
export function writerFor(adapter: CraftAdapter, ext: string): { call: CraftWriteCall; export: boolean } | null {
  const to = adapter.save.to
  if (to && to.formats.includes(ext)) return { call: to, export: false }
  const exported = adapter.exports.find((entry) => entry.formats.includes(ext))
  if (exported) return { call: exported, export: true }
  if (to && !to.formats.length) return { call: to, export: false }
  return null
}

/** Every format a save with a path can write, for the refusal that names them. */
export function writableFormats(adapter: CraftAdapter): string[] {
  return [...new Set([...(adapter.save.to?.formats ?? []), ...adapter.exports.flatMap((entry) => entry.formats)])]
}
