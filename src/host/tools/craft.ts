import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { CRAFT_APPS, craftApp } from '../../shared/craft-apps.ts'
import type { CraftAgentApp, CraftAgentControl, MainAgentOp } from '../../shared/types.ts'
import { messageOf, recordOf, stringOf } from '../json.ts'
import { shrinkPng } from '../png.ts'
import { craftAdapter, documentFileOf, documentOf, fileCall, routeCommand, wireCall, writableFormats, writerFor, type CraftAdapter, type CraftCall } from './craft-adapters.ts'
import { CraftConnection, CraftConnections, CraftError, CraftQueue, type Reply } from './craft-client.ts'
import { failureResult, textResult, type Tool, type ToolResult } from './registry.ts'

// The Craft apps' tools: one fixed set for all twelve, the app named in every call, so a model's
// prompt costs the same with one app installed or all of them. Every call goes the same way:
// main readies the app (`touch`: started parked if it was not running, limits lifted, drawing) and
// says how to reach it; the call then waits its turn in the app's queue (one model's command at a
// time per app) and goes to the app's own control channel from here. Per-app differences are the
// adapter table's (`craft-adapters.ts`), never the schemas'.
//
// Models never install or remove apps: an app that is not installed is refused with a sentence
// telling the model to ask the user, who installs from the shelf.

type Main = (op: MainAgentOp) => Promise<unknown>
type CwdOf = (chatId: string | null) => string | null

export const APP_IDS = CRAFT_APPS.map((app) => app.id)
const RESULT_LIMIT = 12_000
const COMMAND_PAGE = 40
const COMMAND_PARAMS_LIMIT = 400
const SHOT_WIDTH = { default: 1024, max: 4096 }
const BATCH_MAX = 100

/** Seconds each kind of call may take before the model is told the app did not answer. */
export const TIMEOUTS = { run: 90_000, read: 30_000, files: 120_000, screenshot: 30_000, brief: 1_500 }

export type CraftToolOptions = {
  connections?: CraftConnections
  queue?: CraftQueue
  /** Where screenshots that apps write to a file go before they are read back. */
  shotDir?: string
  timeouts?: Partial<typeof TIMEOUTS>
}

/** The shared state behind the tools and the situation line: one queue and one connection per app. */
export class CraftAgent {
  readonly queue: CraftQueue
  readonly connections: CraftConnections
  readonly timeouts: typeof TIMEOUTS
  private shots = 0

  constructor(private readonly main: Main, readonly cwdOf: CwdOf, options: CraftToolOptions = {}) {
    this.queue = options.queue ?? new CraftQueue()
    this.connections = options.connections ?? new CraftConnections((adapter, control, name) => new CraftConnection(adapter, control, name))
    this.shotDir = options.shotDir ?? join(tmpdir(), `craft-studio-shots-${process.pid}`)
    this.timeouts = { ...TIMEOUTS, ...options.timeouts }
  }

  readonly shotDir: string

  async apps(): Promise<CraftAgentApp[]> {
    return await this.main({ op: 'craft', call: 'apps' }) as CraftAgentApp[]
  }

  async touch(app: string, chatId: string | null): Promise<CraftAgentControl> {
    return await this.main({ op: 'craft', call: 'touch', app, folder: this.cwdOf(chatId) }) as CraftAgentControl
  }

  async show(app: string): Promise<unknown> {
    return await this.main({ op: 'uiMap', call: 'go', place: 'app', params: { id: app } })
  }

  /**
   * Ready the app, then run `work` in its turn with a way to send requests. Whatever goes wrong
   * comes back as a full sentence.
   */
  async call<T>(app: string, chatId: string | null, work: (send: Send, control: CraftAgentControl, adapter: CraftAdapter) => Promise<T>): Promise<T> {
    const adapter = craftAdapter(app)!
    const name = craftApp(app)!.name
    const control = await this.touch(app, chatId)
    return await this.queue.run(app, async () => {
      const connection = this.connections.get(adapter, control, name)
      const send: Send = async (call, timeout) => connection.request(call.method, call.params ?? {}, timeout)
      return await work(send, control, adapter)
    })
  }

  /**
   * The open document of a shown or working app, without starting, lifting or waiting for it; null
   * when it cannot say quickly. A resting app is left alone: it may not answer until it draws again.
   */
  async peek(app: CraftAgentApp): Promise<string | null> {
    const adapter = craftAdapter(app.id)
    if (!adapter || !(app.run === 'shown' || app.run === 'working') || this.queue.isBusy(app.id)) return null
    const work = async (): Promise<string | null> => {
      const control = await this.main({ op: 'craft', call: 'control', app: app.id }) as CraftAgentControl | null
      if (!control) return null
      return await this.queue.run(app.id, async () => {
        const connection = this.connections.get(adapter, control, app.name)
        const reply = await connection.request(...asArgs(wireCall(adapter, adapter.brief)), this.timeouts.brief)
        return reply.ok ? documentOf(adapter, reply.result) : null
      })
    }
    const late = new Promise<null>((done) => setTimeout(() => done(null), this.timeouts.brief + 500).unref())
    return await Promise.race([work().catch(() => null), late])
  }

  nextShotPath(app: string): string {
    return join(this.shotDir, `${app}-${++this.shots}.png`)
  }
}

type Send = (call: CraftCall, timeoutMs: number) => Promise<Reply>

function asArgs(call: CraftCall): [string, Record<string, unknown>] {
  return [call.method, call.params ?? {}]
}

/** The start of a long answer, and how much was cut. */
export function clip(text: string, max = RESULT_LIMIT): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters cut; ask for less)` : text
}

// ---- Arguments ----------------------------------------------------------------------------------

/** What a call's arguments must be. Providers do not all validate schemas, so the tools check again. */
type Field = { type: 'string' | 'object' | 'array' | 'number' | 'boolean'; required?: boolean; enum?: string[] }

export function checkArgs(args: Record<string, unknown>, fields: Record<string, Field>): string | null {
  for (const [name, field] of Object.entries(fields)) {
    const value = args[name]
    if (value === undefined || value === null) {
      if (field.required) return `${name} is required.`
      continue
    }
    const ok = field.type === 'array' ? Array.isArray(value)
      : field.type === 'object' ? typeof value === 'object' && !Array.isArray(value)
        : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === field.type
    if (!ok) return `${name} must be ${field.type === 'array' || field.type === 'object' ? `an ${field.type}` : `a ${field.type}`}.`
    if (field.enum && !field.enum.includes(value as string)) return `${name} must be one of ${field.enum.join(', ')}.`
  }
  for (const name of Object.keys(args)) if (!fields[name]) return `${name} is not an argument of this tool; it takes ${Object.keys(fields).join(', ')}.`
  return null
}

const APP_FIELD: Field = { type: 'string', required: true }

/** The app named in a call, or why it cannot be used. Installation is main's to check, on touch. */
function appOf(args: Record<string, unknown>): string | ToolResult {
  const id = stringOf(args.app).trim().toLowerCase()
  if (!craftApp(id)) return failureResult('CRAFT_UNKNOWN_APP', `There is no Craft app "${stringOf(args.app)}". app is one of ${APP_IDS.join(', ')}; craft_apps says which are installed.`)
  return id
}

const appSchema = { type: 'string', enum: APP_IDS, description: 'The app: an installed one from craft_apps.' }

/** A path a model gave, made absolute against the chat's folder. */
export function craftPath(path: string, cwd: string | null): string {
  const given = path.trim()
  if (given === '~' || given.startsWith('~/')) return join(homedir(), given.slice(2))
  return isAbsolute(given) ? resolve(given) : resolve(cwd ?? homedir(), given)
}

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** For an app confined to the folder it was started with, a path outside it is refused before the app sees it. */
function rootProblem(adapter: CraftAdapter, control: CraftAgentControl, name: string, path: string): string | null {
  if (adapter.paths !== 'roots') return null
  if (!control.folder) return `${name} was started without a folder it may read and write, so it cannot open or save files. Ask the user to close it and open it again from the dock while this chat is open.`
  if (!inside(control.folder, path)) return `${name} may only read and write inside ${control.folder}, the folder it was started with; ${path} is outside it. Use a path inside that folder.`
  return null
}

function replyResult(name: string, reply: Reply, max = RESULT_LIMIT): ToolResult {
  if (!reply.ok) return failureResult('CRAFT_APP_ERROR', `${name} refused it: ${reply.error}`, 'operation')
  return textResult(clip(JSON.stringify(reply.result ?? null), max))
}

function guarded(run: (args: Record<string, unknown>, chatId: string | null) => Promise<ToolResult>): Tool['run'] {
  return async (args, context) => {
    try {
      return await run(args, context.chatId)
    } catch (error) {
      return failureResult(error instanceof CraftError ? 'CRAFT_UNAVAILABLE' : 'CRAFT_FAILED', messageOf(error), 'runner')
    }
  }
}

// ---- Commands -----------------------------------------------------------------------------------

/**
 * Commands matching `search`: those whose id or label has every word, or, when none does, those
 * whose params or menu mention them. A page from `offset`, params clipped.
 */
export function findCommands(result: unknown, search: string, offset = 0): { shown: unknown[]; total: number; by: 'all' | 'name' | 'text' } {
  const record = recordOf(result)
  const list = (Array.isArray(result) ? result : Array.isArray(record.commands) ? record.commands : []).map(recordOf)
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const has = (text: string): boolean => words.every((word) => text.includes(word))
  const byName = words.length ? list.filter((entry) => has(`${stringOf(entry.id)} ${stringOf(entry.label)}`.toLowerCase())) : list
  const matching = byName.length || !words.length ? byName : list.filter((entry) => has(JSON.stringify(entry).toLowerCase()))
  const shown = matching.slice(offset, offset + COMMAND_PAGE).map((entry) => {
    const params = typeof entry.params === 'string' ? entry.params : entry.params === undefined ? undefined : JSON.stringify(entry.params)
    return {
      id: entry.id, label: entry.label,
      ...(params ? { params: clip(params, COMMAND_PARAMS_LIMIT) } : {}),
      ...(entry.enabled === false ? { enabled: false } : {})
    }
  })
  return { shown, total: matching.length, by: !words.length ? 'all' : byName.length ? 'name' : 'text' }
}

// ---- Screenshots --------------------------------------------------------------------------------

/** The PNG in a screenshot reply: inline base64 under whatever field name, or a data URL. */
export function inlinePng(result: unknown): Buffer | null {
  const seen = new Set<unknown>()
  const search = (value: unknown, depth: number): string | null => {
    if (typeof value === 'string') {
      const body = value.startsWith('data:image/png;base64,') ? value.slice(22) : value
      return body.startsWith('iVBORw0KGgo') ? body : null
    }
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null
    seen.add(value)
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = search(entry, depth + 1)
      if (found) return found
    }
    return null
  }
  const found = search(result, 0)
  return found ? Buffer.from(found, 'base64') : null
}

// ---- The tools ----------------------------------------------------------------------------------

export function craftTools(agent: CraftAgent): Tool[] {
  const nameOf = (id: string): string => craftApp(id)!.name

  return [
    {
      name: 'craft_apps',
      description: 'List the twelve Craft apps (photos, vectors, video, PDFs, slides, CAD, documents, spreadsheets…) with whether each is installed, running and shown, and the open document of each running one. Only installed apps can be used; for one that is not, suggest it to the user, who installs it from the app shelf. Models never install or remove apps.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: guarded(async () => {
        const apps = await agent.apps()
        const rows = await Promise.all(apps.map(async (app) => {
          const installed = app.installState === 'installed'
          const running = installed && app.run !== 'stopped'
          return {
            app: app.id, name: app.name, like: app.likeName,
            installed, ...(app.installState === 'installing' ? { installing: true } : {}),
            running, shown: app.shown,
            ...(running ? { state: app.run, document: await agent.peek(app) } : {})
          }
        }))
        const installed = rows.filter((row) => row.installed).length
        const note = installed ? '' : '\nNo apps are installed. Suggest one to the user; they install it from the app shelf (+ Add in the dock).'
        return textResult(`${JSON.stringify(rows)}${note}`)
      })
    },
    {
      name: 'craft_show',
      description: 'Show an installed Craft app on the right side of Craft Studio, as its dock icon does: it starts if it is not running. Use it when the user should watch or work in the app; the other craft_* tools work in an app whether or not it is shown.',
      inputSchema: { type: 'object', properties: { app: appSchema }, required: ['app'], additionalProperties: false },
      run: guarded(async (args) => {
        const problem = checkArgs(args, { app: APP_FIELD })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const state = (await agent.apps()).find((entry) => entry.id === app)
        if (state?.installState !== 'installed') return notInstalled(app)
        const shown = recordOf(await agent.show(app))
        if (shown.ok === false) return failureResult('CRAFT_SHOW', stringOf(shown.error) || `${nameOf(app)} could not be shown.`, 'operation')
        return textResult(`${nameOf(app)} is shown on the right side.`)
      })
    },
    {
      name: 'craft_commands',
      description: `Look up an installed Craft app's commands: every menu item, tool and dialog is one. search keeps those whose id or label has all its words (e.g. "insert chart", "gaussian blur"), or, when none does, those whose params mention them. Answers ${COMMAND_PAGE} at a time from offset, each with id, label and params; run them with craft_run.`,
      inputSchema: {
        type: 'object',
        properties: { app: appSchema, search: { type: 'string' }, offset: { type: 'number', description: 'Default 0.' } },
        required: ['app'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, search: { type: 'string' }, offset: { type: 'number' } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const search = stringOf(args.search).trim()
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
        return await agent.call(app, chatId, async (send, _control, adapter) => {
          // The app's own search is used only for one word: a multi-word search goes to the fuller match here.
          const narrow = adapter.commands.search && search && !/\s/.test(search) ? { [adapter.commands.search]: search } : {}
          const reply = await send({ method: adapter.commands.method, params: narrow }, agent.timeouts.read)
          if (!reply.ok) return replyResult(nameOf(app), reply)
          const { shown, total, by } = findCommands(reply.result, search, offset)
          const how = by === 'all' ? `${total} commands` : `${total} commands match "${search}"${by === 'text' ? ' in their params (none by id or label)' : ''}`
          const range = shown.length ? `; ${offset + 1}–${offset + shown.length} below` : ''
          const next = offset + shown.length < total ? `\nThe next page starts at offset ${offset + shown.length}.` : ''
          return textResult(`${nameOf(app)}: ${how}${range}.\n${clip(JSON.stringify(shown), 24_000)}${next}`)
        })
      })
    },
    {
      name: 'craft_run',
      description: `Run one command in an installed Craft app: an engine command id from craft_commands (e.g. GridCraft range.setValues, insert.chart; PhotoCraft file.new, paint.stroke, edit.fill) or one of the app's control methods (ui.pointer, ui.key, ui.dialog.set, sheet.read, cmdline.input…). The app starts parked if it is not running. Answers with the command's result. Use craft_open and craft_save for files.`,
      inputSchema: {
        type: 'object',
        properties: {
          app: appSchema,
          command: { type: 'string', description: 'Command id or control method.' },
          params: { type: 'object', description: 'The command\'s params, e.g. {"range": "A1:B2", "values": [[1, 2], [3, 4]]}.' }
        },
        required: ['app', 'command'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, command: { type: 'string', required: true }, params: { type: 'object' } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const route = routeCommand(craftAdapter(app)!, stringOf(args.command).trim(), recordOf(args.params))
        if ('refused' in route) return failureResult('CRAFT_REFUSED', `${stringOf(args.command)} is not available to models: ${route.refused}`)
        return await agent.call(app, chatId, async (send) => replyResult(nameOf(app), await send(route.call, agent.timeouts.run)))
      })
    },
    {
      name: 'craft_batch',
      description: `Run several commands in one installed Craft app in order, as craft_run would one by one, with no other model's command between them. Stops at the first failure unless stop_on_error is false. Answers with each step's result. At most ${BATCH_MAX} steps.`,
      inputSchema: {
        type: 'object',
        properties: {
          app: appSchema,
          steps: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, params: { type: 'object' } }, required: ['command'] } },
          stop_on_error: { type: 'boolean', description: 'Default true.' }
        },
        required: ['app', 'steps'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, steps: { type: 'array', required: true }, stop_on_error: { type: 'boolean' } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const steps = (args.steps as unknown[]).map(recordOf)
        if (!steps.length) return failureResult('CRAFT_ARGS', 'Give at least one step: {"command": id, "params": {...}}.')
        if (steps.length > BATCH_MAX) return failureResult('CRAFT_ARGS', `A batch holds at most ${BATCH_MAX} steps; split it.`)
        const adapter = craftAdapter(app)!
        const routes = steps.map((step, index) => {
          const command = stringOf(step.command).trim()
          if (!command) return { index, refused: 'each step needs a command.' }
          if (step.params !== undefined && (typeof step.params !== 'object' || Array.isArray(step.params) || step.params === null)) return { index, refused: 'params must be an object.' }
          return { index, command, ...routeCommand(adapter, command, recordOf(step.params)) }
        })
        const bad = routes.find((route) => 'refused' in route)
        if (bad && 'refused' in bad) return failureResult('CRAFT_REFUSED', `Step ${bad.index + 1} was refused, so nothing ran: ${bad.refused}`)
        const stopOnError = args.stop_on_error !== false
        return await agent.call(app, chatId, async (send) => {
          const results: Array<Record<string, unknown>> = []
          let failed = 0
          for (const route of routes) {
            if (!('call' in route)) continue
            const reply = await send(route.call, agent.timeouts.run)
            results.push({ command: route.command, ok: reply.ok, ...(reply.ok ? { result: reply.result } : { error: reply.error }) })
            if (!reply.ok) {
              failed++
              if (stopOnError) break
            }
          }
          const text = clip(JSON.stringify({ completed: results.length - failed, failed, of: routes.length, results }))
          return failed && stopOnError ? failureResult('CRAFT_APP_ERROR', `${nameOf(app)} stopped at step ${results.length}: ${text}`, 'operation') : textResult(text)
        })
      })
    },
    {
      name: 'craft_inspect',
      description: 'The state of an installed Craft app: by default its document (layers, sheets, slides, tracks, pages, selection…); with what "ui", its interface (tool, open dialog, panels, canvas rect for pointer input). Long answers are clipped.',
      inputSchema: {
        type: 'object',
        properties: { app: appSchema, what: { type: 'string', enum: ['document', 'ui'], description: 'Default document.' } },
        required: ['app'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, what: { type: 'string', enum: ['document', 'ui'] } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        return await agent.call(app, chatId, async (send, _control, adapter) =>
          replyResult(nameOf(app), await send(wireCall(adapter, args.what === 'ui' ? adapter.ui : adapter.inspect), agent.timeouts.read)))
      })
    },
    {
      name: 'craft_open',
      description: 'Open a file in an installed Craft app (a photo in PhotoCraft, a workbook in GridCraft, a PDF in PdfCraft…). A relative path is taken from the chat\'s folder. Answers with what the app reports about the opened document.',
      inputSchema: { type: 'object', properties: { app: appSchema, path: { type: 'string' } }, required: ['app', 'path'], additionalProperties: false },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, path: { type: 'string', required: true } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const adapter = craftAdapter(app)!
        if (!adapter.open) return failureResult('CRAFT_NO_OPEN', `${nameOf(app)} has no way to open a file over its control channel. Ask the user to open it.`)
        const file = craftPath(stringOf(args.path), agent.cwdOf(chatId))
        const info = await stat(file).catch(() => null)
        if (!info) return failureResult('CRAFT_NO_FILE', `There is no file at ${file}. Check the path; a relative one is taken from the chat's folder.`)
        return await agent.call(app, chatId, async (send, control) => {
          const outside = rootProblem(adapter, control, nameOf(app), file)
          if (outside) return failureResult('CRAFT_OUTSIDE_FOLDER', outside)
          return replyResult(nameOf(app), await send(fileCall(adapter, adapter.open!, file), agent.timeouts.files))
        })
      })
    },
    {
      name: 'craft_save',
      description: 'Save the active document of an installed Craft app. Without path it is saved to its own file. With path (relative to the chat\'s folder) it is written there, the format chosen by the extension (or format, which also adds the extension when the path has none); formats the app\'s own Save does not write are exported. Missing folders are made.',
      inputSchema: {
        type: 'object',
        properties: { app: appSchema, path: { type: 'string' }, format: { type: 'string', description: 'e.g. png, pdf, xlsx; default from the extension.' } },
        required: ['app'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, path: { type: 'string' }, format: { type: 'string' } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const adapter = craftAdapter(app)!
        const format = stringOf(args.format).trim().replace(/^\./, '').toLowerCase()
        let target: string | null = stringOf(args.path).trim() ? craftPath(stringOf(args.path), agent.cwdOf(chatId)) : null
        if (target && format && !extname(target)) target = `${target}.${format}`
        if (!target && format) return failureResult('CRAFT_ARGS', 'Give a path with the format, e.g. {"path": "poster.png"}.')
        const ext = (format || extname(target ?? '').slice(1)).toLowerCase()
        const writer = target ? writerFor(adapter, ext) : null
        if (target && !writer) {
          const formats = writableFormats(adapter)
          return failureResult('CRAFT_NO_SAVE', formats.length
            ? `${nameOf(app)} cannot write ${ext ? `.${ext}` : 'a file without an extension'} over its control channel; it writes ${formats.join(', ')}. Give a path with one of those.`
            : `${nameOf(app)} cannot save to a path over its control channel${adapter.save.own ? '; leave out path to save the document back to its own file' : ''}. Ask the user to save it.`)
        }
        if (!target && !adapter.save.own) return failureResult('CRAFT_NO_SAVE', `${nameOf(app)} keeps its changes itself and has nothing to save; give a path to export to (${writableFormats(adapter).join(', ')}).`)
        if (target) {
          try {
            await mkdir(dirname(target), { recursive: true })
          } catch (error) {
            return failureResult('CRAFT_NOT_WRITABLE', `Craft Studio cannot write to ${dirname(target)} (${messageOf(error)}). Save somewhere writable, such as the chat's folder.`)
          }
        }
        return await agent.call(app, chatId, async (send, control) => {
          let call: CraftCall
          if (target && writer) {
            const outside = rootProblem(adapter, control, nameOf(app), target)
            if (outside) return failureResult('CRAFT_OUTSIDE_FOLDER', outside)
            const extra: Record<string, unknown> = { ...writer.call.paramsFor?.[ext] }
            if (writer.call.formatField && ext) extra[writer.call.formatField] = ext
            call = fileCall(adapter, writer.call, target, extra)
          } else {
            // Without a file of its own, Save would open a native dialog no model can answer.
            if (adapter.save.ownNeedsFile) {
              const brief = await send(wireCall(adapter, adapter.brief), agent.timeouts.read)
              const own = brief.ok ? documentFileOf(adapter, brief.result) : null
              if (!own) return failureResult('CRAFT_NEEDS_PATH', `${adapter.fileFields.length ? 'This document has no file of its own yet' : `${nameOf(app)} does not say whether the document has a file`}, and saving it without one would open a dialog. Give a path, e.g. {"path": "${exampleName(adapter)}"}.`)
            }
            call = wireCall(adapter, adapter.save.own!)
          }
          const reply = await send(call, agent.timeouts.files)
          if (!reply.ok) return replyResult(nameOf(app), reply)
          const written = target ? await stat(target).catch(() => null) : null
          const said = recordOf(reply.result)
          return textResult(JSON.stringify({
            ...said, ...(target ? { file: target, bytes: written?.size ?? null, ...(writer?.export ? { exported: true } : {}) } : {}),
            ...(target && !written && said.background !== true ? { warning: `${nameOf(app)} answered but no file is at ${target} yet.` } : {})
          }))
        })
      })
    },
    {
      name: 'craft_screenshot',
      description: `A picture of an installed Craft app's window as the user would see it, whether or not it is shown right now. Scaled to at most maxWidth pixels wide (default ${SHOT_WIDTH.default}; 0 for full size).`,
      inputSchema: {
        type: 'object',
        properties: { app: appSchema, maxWidth: { type: 'number', description: `Default ${SHOT_WIDTH.default}, at most ${SHOT_WIDTH.max}; 0 for full size.` } },
        required: ['app'], additionalProperties: false
      },
      run: guarded(async (args, chatId) => {
        const problem = checkArgs(args, { app: APP_FIELD, maxWidth: { type: 'number' } })
        if (problem) return failureResult('CRAFT_ARGS', problem)
        const app = appOf(args)
        if (typeof app !== 'string') return app
        const asked = args.maxWidth === undefined ? SHOT_WIDTH.default : Math.floor(Number(args.maxWidth))
        const maxWidth = asked <= 0 ? Infinity : Math.min(Math.max(asked, 64), SHOT_WIDTH.max)
        return await agent.call(app, chatId, async (send, _control, adapter) => {
          let png: Buffer | null
          if (adapter.screenshot.returns === 'path') {
            const file = agent.nextShotPath(app)
            await mkdir(dirname(file), { recursive: true, mode: 0o700 })
            const reply = await send({ method: adapter.screenshot.method, params: { ...adapter.screenshot.params, path: file } }, agent.timeouts.screenshot)
            if (!reply.ok) return replyResult(nameOf(app), reply)
            png = await readFile(file).catch(() => null) ?? inlinePng(reply.result)
            await rm(file, { force: true })
          } else {
            const reply = await send({ method: adapter.screenshot.method, params: { ...adapter.screenshot.params } }, agent.timeouts.screenshot)
            if (!reply.ok) return replyResult(nameOf(app), reply)
            png = inlinePng(reply.result)
          }
          if (!png) return failureResult('CRAFT_NO_IMAGE', `${nameOf(app)} answered without a picture. Try again in a moment.`, 'operation')
          const full = shrinkPng(png, Number.MAX_SAFE_INTEGER)
          const out = Number.isFinite(maxWidth) ? shrinkPng(png, maxWidth) : full
          const size = out.scaled ? `${full.width}×${full.height}, scaled to ${out.width}×${out.height}` : `${out.width}×${out.height}`
          return { content: [{ type: 'text', text: `${nameOf(app)} window, ${size}.` }, { type: 'image', data: out.data.toString('base64'), mimeType: 'image/png' }] }
        })
      })
    }
  ]
}

function exampleName(adapter: CraftAdapter): string {
  const format = adapter.save.to?.formats[0] ?? craftApp(adapter.id)!.extensions[0]
  return `untitled.${format}`
}

function notInstalled(app: string): ToolResult {
  return failureResult('CRAFT_NOT_INSTALLED', `${craftApp(app)!.name} is not installed. Ask the user to install it from the app shelf (+ Add in the dock); models cannot install apps.`)
}

/**
 * The line ahead of each message: which apps are installed, which is shown, which are running, and
 * the shown app's document. Never starts or lifts an app, and gives up on the document after a
 * moment rather than hold the message.
 */
export async function craftSituation(agent: CraftAgent): Promise<string | null> {
  let apps: CraftAgentApp[]
  try {
    apps = await agent.apps()
  } catch {
    return null
  }
  const installed = apps.filter((app) => app.installState === 'installed')
  if (!installed.length) return '<craft-apps>No Craft apps are installed. Suggest one when it would help; the user installs it from the app shelf. craft_apps lists them.</craft-apps>'
  const shown = installed.find((app) => app.shown)
  const document = shown ? await agent.peek(shown) : null
  const describe = (app: CraftAgentApp): string => {
    const state = app.shown ? `shown${document ? `, ${document}` : ''}` : app.run === 'stopped' ? 'not running' : app.run === 'starting' ? 'starting' : `running, ${app.run}`
    return `${app.name} (${app.id}: ${state})`
  }
  return `<craft-apps>Installed: ${installed.map(describe).join('; ')}. Drive them with the craft_* tools, naming the app; ${apps.length - installed.length} more can be suggested for the user to install.</craft-apps>`
}
